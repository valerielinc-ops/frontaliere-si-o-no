/**
 * bfsBaselineJustification.mjs
 *
 * "Registered" is not "covered": the second, static half of the BFS-depth
 * ratchet (issue #5545).
 *
 * The problem
 * -----------
 * `audit-bfs-depth.mjs` compares every sitemap against ITS OWN entry in
 * `data/bfs-depth-baseline.json`. That is the right shape for absorbing
 * organic growth, but it means a shard's baseline number is never itself
 * judged: register a family at 88.99% below crawl depth and the gate is green
 * forever, because 88.99% is what the gate was told to expect.
 *
 * `sitemap-health-facilities.xml` sat at 388/436 (88.99%) for months. That
 * number was not an accepted trade-off, it was an undiagnosed defect —
 * `pickFacilities()` capped the linked set at a CONSTANT 48 while the family
 * grew with the corpus, so 380 emitted, sitemap-listed pages were linked from
 * nothing (#5434, fixed by #5543). The ratchet could not have caught it: with
 * a constant cap against a growing family the buried SHARE rises slowly and
 * monotonically, which is exactly the shape a ratchet is designed to ignore.
 *
 * Two holes, and which one this file closes
 * -----------------------------------------
 * 1. DRIFT against a fixed baseline. Partly closed already: the `capSaturated`
 *    arm in `evaluateBfsGate` stops a >~87% shard from being rate-immune. What
 *    remains is bounded but real — for every entry above 53.33% the relative
 *    term saturates at `maxDeltaPp`, so the tolerance degenerates to a FLAT
 *    +13pp (8 + 5) regardless of how bad the baseline already is. Measured on
 *    the shipped baseline: 4,015 further URLs can be buried across the 30 high
 *    entries before the rate arm trips (1,585 of them on
 *    `sitemap-locale-variants-001.xml` alone).
 * 2. REBASELINING. Entirely unguarded, and this is the one this file closes.
 *    `npm run audit:max-bfs-depth:rebaseline` overwrites every number with
 *    whatever the current build measured; `seed-bfs-depth-baseline.yml`
 *    literally instructs "Replace data/bfs-depth-baseline.json with the
 *    downloaded file, commit, push". Nothing anywhere compares the new file to
 *    the old one, so a regression that happens to be rebaselined is accepted
 *    silently and permanently — and in a 68-entry JSON a single rate moving
 *    75.00 → 88.00 is invisible in review.
 *
 * What this module does
 * ---------------------
 * A pure, static check over the baseline FILE — no dist, no crawl, so it runs
 * in the normal `tests` job on every PR, i.e. at the moment a high baseline
 * would be REGISTERED rather than post-deploy once it already shipped.
 *
 * An entry is HIGH when at least `HIGH_BASELINE_RATE_PCT` of its URLs are
 * below crawl depth over at least `HIGH_BASELINE_MIN_BURIED` of them. A high
 * entry is an unusually strong claim — "the MAJORITY of this family is
 * unreachable and that is fine" — so it must either
 *   (a) carry a written `reason` in the baseline JSON, on the model of the
 *       `mode`/`reason` pairs in the corpus's `loop-sync-manifest.json`, or
 *   (b) appear in `UNJUSTIFIED_HIGH_BASELINES` below — the grandfathered
 *       ledger of what was already high on 2026-08-10, frozen at the rate it
 *       had that day.
 *
 * The ledger is a shrink-only ratchet, which is what stops it becoming the
 * stale list nobody rereads (the failure mode the issue calls out):
 *   - a NEW high entry that is in neither (a) nor (b) FAILS. This is the hole:
 *     from now on a family cannot be registered as majority-unreachable
 *     without someone writing down why.
 *   - a ledger entry whose rate AND buried count both grew FAILS. A
 *     grandfathered defect may be carried, never widened.
 *   - a ledger entry that has been fixed, or has since been given a reason,
 *     FAILS with "delete this line". The list cannot rot: it only ever gets
 *     shorter, and every removal is a real improvement.
 *
 * Deliberately NOT done here
 * --------------------------
 * Nothing in this module reads, writes, or relaxes a single baseline number.
 * Making a high baseline VISIBLE is the whole job; widening one stays a
 * deliberate human act (AGENTS.md non-negotiables #1 and #5).
 */

// 50%: chosen from the shipped distribution, not as a round number. The 68
// baseline entries are strongly clustered — 29 sit at exactly 0, nothing at
// all lives between 0 and 11.54%, and the single widest empty band in the
// whole distribution is 39.62% → 61.50%. 50 sits inside that gap, so it
// separates "a minority of this family is deep" from "the majority of this
// family is unreachable" without cutting through a cluster. It also captures
// where the harm actually is: 23,942 of the 26,398 registered buried URLs
// (91%) belong to entries above it.
export const HIGH_BASELINE_RATE_PCT = 50;

// Mirrors `tolerance.minAbsDelta`. A 3-URL sitemap at 100% is a rounding
// artifact, not a content tier worth prose; the same floor the ratchet uses
// for noise is the right floor for "big enough to demand a justification".
export const HIGH_BASELINE_MIN_BURIED = 20;

// A rebaseline after organic growth moves both numbers together at a flat
// rate, and `ratePct` is stored rounded to 4dp, so "the rate went up" needs a
// noise floor or every routine rebaseline trips the widening arm. 0.5pp is
// below any structural change (those move whole points) and above rounding.
export const WIDENING_EPSILON_PP = 0.5;

// Reasons must say something. These are the strings that look like a reason
// while asserting nothing — the exact move this check exists to prevent, since
// a `reason` field that can be satisfied by "TODO" reproduces the original
// defect with extra ceremony.
const PLACEHOLDER_REASON_RE = /^(?:n\/?a|tbd|todo|fixme|wip|\?+|-+|none|unknown|da\s+fare|vedi\s+sopra)\b/i;
const REASON_MIN_LENGTH = 30;

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is prose a reviewer could actually
 *   disagree with, rather than a placeholder that silences the check.
 */
export function isSubstantiveReason(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < REASON_MIN_LENGTH) return false;
  if (PLACEHOLDER_REASON_RE.test(trimmed)) return false;
  // Require at least a few real words — a 30-char slug or URL is not a reason.
  return trimmed.split(/\s+/).filter((w) => /[\p{L}]/u.test(w)).length >= 5;
}

/**
 * Entries of `data/bfs-depth-baseline.json` that were already HIGH when this
 * check was introduced (2026-08-10, commit 3030ae482), frozen at the rate they
 * had then. Carried, not accepted: each line is a family whose majority is
 * unreachable and for which nobody has yet written down why.
 *
 * Two clusters, both of them one defect each rather than 30:
 *   - 26 entries pinned at ~75.0% — the three non-default locales of every
 *     cantonal jobs family (and the Italian fuel families) sitting below crawl
 *     depth. 75% is 3/4, and it is the same second offender set that #5434
 *     found on health-facilities ("144 = 48 × the 3 non-default locales").
 *   - `sitemap-locale-variants-001.xml` at 78.72%, 9,602 URLs — the single
 *     largest buried population in the file by an order of magnitude.
 *
 * HOW TO REMOVE A LINE (the only two legal edits):
 *   1. Fix the internal linking so the rate drops below HIGH_BASELINE_RATE_PCT,
 *      rebaseline, delete the line. This is the intended path.
 *   2. Diagnose it and decide the buried state is genuinely correct, then move
 *      the justification into the baseline JSON as a `reason` on that entry and
 *      delete the line here.
 * Raising a frozen number to make the check pass is the one edit that is not
 * available: that is the widening this exists to catch.
 *
 * @type {Record<string, { ratePct: number, atDepthGtMax: number }>}
 */
export const UNJUSTIFIED_HIGH_BASELINES = {
  'sitemap-comuni-frontiera.xml': { ratePct: 95, atDepthGtMax: 304 }, // 304/320 URL
  'sitemap-health-facilities.xml': { ratePct: 88.9908, atDepthGtMax: 388 }, // 388/436 URL
  'sitemap-weather.xml': { ratePct: 88.8889, atDepthGtMax: 32 }, // 32/36 URL
  'sitemap-weather-alerts.xml': { ratePct: 88.8889, atDepthGtMax: 32 }, // 32/36 URL
  'sitemap-locale-variants-001.xml': { ratePct: 78.7178, atDepthGtMax: 9602 }, // 9602/12198 URL
  'sitemap-jobs-uri.xml': { ratePct: 76.087, atDepthGtMax: 70 }, // 70/92 URL
  'sitemap-jobs-basilea.xml': { ratePct: 75.3703, atDepthGtMax: 1374 }, // 1374/1823 URL
  'sitemap-jobs-zurigo.xml': { ratePct: 75.0068, atDepthGtMax: 2755 }, // 2755/3673 URL
  'sitemap-jobs-vaud.xml': { ratePct: 75, atDepthGtMax: 870 }, // 870/1160 URL
  'sitemap-fuel-italian-stations.xml': { ratePct: 75, atDepthGtMax: 642 }, // 642/856 URL
  'sitemap-jobs-sciaffusa.xml': { ratePct: 75, atDepthGtMax: 189 }, // 189/252 URL
  'sitemap-jobs-neuchatel.xml': { ratePct: 75, atDepthGtMax: 96 }, // 96/128 URL
  'sitemap-jobs-giura.xml': { ratePct: 75, atDepthGtMax: 66 }, // 66/88 URL
  'sitemap-fuel-italian-cities.xml': { ratePct: 75, atDepthGtMax: 66 }, // 66/88 URL
  'sitemap-jobs-zugo.xml': { ratePct: 75, atDepthGtMax: 63 }, // 63/84 URL
  'sitemap-jobs-glarona.xml': { ratePct: 75, atDepthGtMax: 39 }, // 39/52 URL
  'sitemap-jobs-nidvaldo.xml': { ratePct: 75, atDepthGtMax: 33 }, // 33/44 URL
  'sitemap-jobs-appenzello.xml': { ratePct: 75, atDepthGtMax: 24 }, // 24/32 URL
  'sitemap-jobs-argovia.xml': { ratePct: 74.9693, atDepthGtMax: 611 }, // 611/815 URL
  'sitemap-jobs-vallese.xml': { ratePct: 74.9471, atDepthGtMax: 709 }, // 709/946 URL
  'sitemap-jobs-lucerna.xml': { ratePct: 74.9447, atDepthGtMax: 1017 }, // 1017/1357 URL
  'sitemap-jobs-grigioni.xml': { ratePct: 74.9339, atDepthGtMax: 1133 }, // 1133/1512 URL
  'sitemap-jobs-berna.xml': { ratePct: 74.9108, atDepthGtMax: 1469 }, // 1469/1961 URL
  'sitemap-jobs-friburgo.xml': { ratePct: 74.9077, atDepthGtMax: 203 }, // 203/271 URL
  'sitemap-jobs-san-gallo.xml': { ratePct: 74.8971, atDepthGtMax: 364 }, // 364/486 URL
  'sitemap-jobs-ginevra.xml': { ratePct: 74.8954, atDepthGtMax: 716 }, // 716/956 URL
  'sitemap-jobs-turgovia.xml': { ratePct: 74.8954, atDepthGtMax: 179 }, // 179/239 URL
  'sitemap-jobs-svitto.xml': { ratePct: 74.8899, atDepthGtMax: 170 }, // 170/227 URL
  'sitemap-jobs-soletta.xml': { ratePct: 74.7664, atDepthGtMax: 480 }, // 480/642 URL
  'sitemap-fuel-stations.xml': { ratePct: 61.5, atDepthGtMax: 246 }, // 246/400 URL
};

/**
 * Pure decision core. No I/O — the caller supplies the parsed baseline so this
 * is exercisable from a unit test without a dist or a crawl.
 *
 * @param {object} args
 * @param {{ perSitemap?: Record<string, { total?: number, atDepthGtMax?: number, ratePct?: number, reason?: unknown }> }} args.baseline
 * @param {Record<string, { ratePct: number, atDepthGtMax: number }>} [args.ledger]
 * @param {number} [args.rateThresholdPct]
 * @param {number} [args.minBuried]
 * @param {number} [args.wideningEpsilonPp]
 * @returns {{
 *   high: Array<{ name: string, ratePct: number, atDepthGtMax: number, total: number, status: 'justified'|'grandfathered'|'unjustified'|'widened' }>,
 *   unjustified: Array<{ name: string, ratePct: number, atDepthGtMax: number, total: number }>,
 *   widened: Array<{ name: string, ratePct: number, atDepthGtMax: number, frozenRatePct: number, frozenBuried: number }>,
 *   staleLedger: Array<{ name: string, why: 'fixed'|'justified'|'absent', ratePct: number | null }>,
 *   justified: string[]
 * }}
 */
export function evaluateBaselineJustification({
  baseline,
  ledger = UNJUSTIFIED_HIGH_BASELINES,
  rateThresholdPct = HIGH_BASELINE_RATE_PCT,
  minBuried = HIGH_BASELINE_MIN_BURIED,
  wideningEpsilonPp = WIDENING_EPSILON_PP,
} = {}) {
  const perSitemap = baseline?.perSitemap ?? {};
  const high = [];
  const unjustified = [];
  const widened = [];
  const staleLedger = [];
  const justified = [];

  for (const [name, row] of Object.entries(perSitemap)) {
    const total = Number(row?.total ?? 0);
    const buried = Number(row?.atDepthGtMax ?? 0);
    // Recompute rather than trusting the stored `ratePct`: a hand-edited entry
    // that lowers `ratePct` while leaving the counts alone would otherwise walk
    // straight out of the check.
    const ratePct = total > 0 ? (buried / total) * 100 : 0;
    if (ratePct < rateThresholdPct || buried < minBuried) continue;

    const frozen = Object.prototype.hasOwnProperty.call(ledger, name) ? ledger[name] : null;
    if (isSubstantiveReason(row?.reason)) {
      justified.push(name);
      high.push({ name, ratePct, atDepthGtMax: buried, total, status: 'justified' });
      // A justified entry must not ALSO sit in the ledger: two places claiming
      // the same entry means one of them stops being read.
      if (frozen) staleLedger.push({ name, why: 'justified', ratePct });
      continue;
    }
    if (!frozen) {
      unjustified.push({ name, ratePct, atDepthGtMax: buried, total });
      high.push({ name, ratePct, atDepthGtMax: buried, total, status: 'unjustified' });
      continue;
    }
    // Grandfathered. Widening needs BOTH arms, same shape as the ratchet's own
    // AND-condition and for the same reason (#1604): a rebaseline after pure
    // organic growth raises `atDepthGtMax` at a flat rate, and a corpus
    // contraction raises `ratePct` with the count flat. Neither buries a new
    // URL; only both moving together does.
    const rateGrew = ratePct > frozen.ratePct + wideningEpsilonPp;
    const countGrew = buried > frozen.atDepthGtMax;
    if (rateGrew && countGrew) {
      widened.push({
        name,
        ratePct,
        atDepthGtMax: buried,
        frozenRatePct: frozen.ratePct,
        frozenBuried: frozen.atDepthGtMax,
      });
      high.push({ name, ratePct, atDepthGtMax: buried, total, status: 'widened' });
    } else {
      high.push({ name, ratePct, atDepthGtMax: buried, total, status: 'grandfathered' });
    }
  }

  // Shrink-only: a ledger line that no longer describes a high entry has to go,
  // otherwise the list slowly fills with entries nobody rereads — the very
  // dynamic this check was opened against.
  for (const name of Object.keys(ledger)) {
    const row = perSitemap[name];
    if (!row) {
      staleLedger.push({ name, why: 'absent', ratePct: null });
      continue;
    }
    const total = Number(row.total ?? 0);
    const buried = Number(row.atDepthGtMax ?? 0);
    const ratePct = total > 0 ? (buried / total) * 100 : 0;
    if (ratePct < rateThresholdPct || buried < minBuried) {
      staleLedger.push({ name, why: 'fixed', ratePct });
    }
  }

  high.sort((a, b) => b.ratePct - a.ratePct);
  return { high, unjustified, widened, staleLedger, justified };
}

/**
 * `--write-baseline` rebuilds every entry from the current measurement, so a
 * `reason` written into the baseline would be erased by the next rebaseline
 * and the whole mechanism would quietly become vacuous after one run. Carry
 * reasons across — but only onto an entry that did not get worse: a
 * justification was written about a specific number, and once that number
 * regresses the justification has to be re-argued rather than inherited.
 *
 * @param {object} args
 * @param {Record<string, { ratePct?: number, reason?: unknown, [k: string]: unknown }>} [args.previousPerSitemap]
 * @param {Record<string, { ratePct?: number, reason?: unknown, [k: string]: unknown }>} args.nextPerSitemap  mutated in place
 * @param {number} [args.wideningEpsilonPp]
 * @returns {{ carried: string[], dropped: Array<{ name: string, from: number, to: number }> }}
 */
export function carryForwardReasons({ previousPerSitemap = {}, nextPerSitemap, wideningEpsilonPp = WIDENING_EPSILON_PP }) {
  const carried = [];
  const dropped = [];
  for (const [name, prev] of Object.entries(previousPerSitemap ?? {})) {
    if (!isSubstantiveReason(prev?.reason)) continue;
    const next = nextPerSitemap?.[name];
    if (!next) continue;
    const from = Number(prev.ratePct ?? 0);
    const to = Number(next.ratePct ?? 0);
    if (to > from + wideningEpsilonPp) {
      dropped.push({ name, from, to });
      continue;
    }
    next.reason = String(prev.reason);
    carried.push(name);
  }
  return { carried, dropped };
}

/**
 * Human-readable roll-up of the high end of the baseline — the periodic report
 * half of #5545. Rendered by the audit on every gated run and by
 * `npm run report:bfs-high-baselines`, so the list is put back in front of
 * someone instead of only existing as a number nobody rereads.
 *
 * @param {ReturnType<typeof evaluateBaselineJustification>} verdict
 * @param {number} [rateThresholdPct]
 * @returns {string[]} lines, caller decides the stream
 */
export function formatHighBaselineReport(verdict, rateThresholdPct = HIGH_BASELINE_RATE_PCT) {
  const lines = [];
  const buried = verdict.high.reduce((s, h) => s + h.atDepthGtMax, 0);
  lines.push(
    `[bfs-baseline] ${verdict.high.length} sitemap(s) registered at ≥${rateThresholdPct}% below crawl depth — ${buried} URLs accepted as unreachable`,
  );
  const mark = { justified: 'reason', grandfathered: 'UNJUSTIFIED (ledger)', unjustified: 'UNJUSTIFIED (new)', widened: 'WIDENED' };
  for (const h of verdict.high) {
    lines.push(`  ${h.ratePct.toFixed(2).padStart(6)}%  ${String(h.atDepthGtMax).padStart(6)}/${String(h.total).padEnd(7)} ${h.name}  [${mark[h.status]}]`);
  }
  return lines;
}
