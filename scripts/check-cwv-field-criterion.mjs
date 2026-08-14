#!/usr/bin/env node
/**
 * check-cwv-field-criterion.mjs — the machine-readable acceptance criterion
 * for issue #5001, replacing "PageSpeed Insights score > 90 mobile".
 *
 * WHY THE CRITERION CHANGED
 * -------------------------
 * The lab score points at the wrong page on this site. Measured 2026-08-07 on
 * production, mobile:
 *
 *   /cerca-lavoro-ticino/   lab perf 0.03  — but the BEST field LCP of the site
 *                                            (1700 ms p75, 89% good)
 *   /cerca-lavoro-svizzera/ lab perf 0.94  — and a field INP p75 of 4085 ms,
 *                                            the worst page on the site
 *
 * Two pages, opposite lab verdicts, and in both cases the lab verdict inverts
 * what real users get. A gate built on the lab score would have chased the
 * first page and never looked at the second. What users actually suffer here is
 * INP and CLS, and those are only visible in FIELD data.
 *
 * So: field data decides whether #5001 can close (this script). The lab score
 * stays as a CI anti-regression guard (lighthouserc.json / lighthouserc.desktop.json)
 * where it is good — detecting that a deploy made things worse — and is no
 * longer asked to define "done".
 *
 * WHY CrUX AND NOT THE FIRST-PARTY RUM
 * ------------------------------------
 * CrUX remains the criterion, but the reason below is HISTORICAL — do not
 * quote it as a current fact. It was written on 2026-08-07 and stopped being
 * true on 2026-08-10; between those dates it was cited to close #5607 and
 * #5670, which had to be reopened on 2026-08-14. Re-measure before reusing it.
 *
 * The state of the first-party telemetry when this script was written:
 *   - PostHog ingestion stopped 2026-07-23 (all events fell from ~90-100k/day
 *     to <30/day). data/cwv-monitor-history.json records n=0 for every page on
 *     2026-08-05 — scripts/cwv-monitor-check.mjs was blind from then on.
 *
 *     RESOLVED 2026-08-10: ingestion resumed the same day and has been healthy
 *     since. Measured 2026-08-14 (events/day): 08-09 = 7, 08-10 = 65.975,
 *     08-11 = 102.449, 08-12 = 104.651, 08-13 = 116.003. PostHog is NOT blind
 *     today. The three-week hole is now detected rather than assumed:
 *     scripts/lib/source-liveness.mjs makes every PostHog monitor prove its
 *     source is alive over the window it measures, and abstain out loud if it
 *     is not.
 *   - GA4 has never received a single `web_vitals` event (0 in 90 days) because
 *     services/webVitals.ts called `(Analytics as any).log?.(...)` and
 *     `Analytics` has no `log` member, so the optional call silently no-opped.
 *     Fixed in the same PR as this script, but GA4 needs time to accumulate.
 *
 * CrUX is the only field source that works today, and it is also the source
 * Google itself ranks on. It lags: each reading is a trailing 28-day window, so
 * a fix landing today first shows up partially ~7 days later and fully ~28 days
 * later. Budget for that when reading a FAIL.
 *
 * EXIT CODES
 *   0  criterion met
 *   1  criterion not met (the expected state until the work is done)
 *   2  data unavailable — LOUD, never a silent pass. This is the specific
 *      failure mode that let the PostHog monitor record nulls for two weeks
 *      without anyone noticing.
 *
 * USAGE
 *   node scripts/check-cwv-field-criterion.mjs            # human table
 *   node scripts/check-cwv-field-criterion.mjs --json     # machine output
 *   node scripts/check-cwv-field-criterion.mjs --markdown # issue/PR comment
 *
 * ENV
 *   PAGESPEED_API_KEY — required (CrUX API key; same key, loaded via
 *                       scripts/load-rc-env.mjs from Remote Config)
 */

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'https://frontaliereticino.ch';
const API = 'https://chromeuxreport.googleapis.com/v1';

/**
 * The binding closure gate for #5001. Origin-level, PHONE, p75.
 *
 * Thresholds are motivated by what this origin has actually demonstrated, not
 * by copying Google's table wholesale — an unreachable criterion is as useless
 * as a wrong one.
 *
 *   INP <= 200 ms  — Google "good", and PROVEN ON THIS SITE: the origin measured
 *                    158 ms on 2026-04-04 and stayed under 200 through
 *                    2026-04-18. This is a regression to undo, not a new
 *                    capability to build. It then degraded monotonically for 17
 *                    straight weekly windows (158 -> 426 ms, ~+16 ms/week) with
 *                    no reversal. Distance from the 2026-08-07 baseline of
 *                    440 ms: -240 ms.
 *
 *   CLS <= 0.15    — deliberately NOT Google's 0.10. Best ever recorded on this
 *                    origin is 0.17 (2026-06-27), and it has sat at 0.17-0.18
 *                    for six consecutive weeks after a real delivered win took
 *                    it from 0.76 to 0.17 in five weeks. A six-week plateau is
 *                    evidence the cheap wins are spent and the residue is
 *                    structural: PostHog attribution names the app shell
 *                    (0.172), the footer (0.286-0.302) and the AdSense rail
 *                    grid (0.126-0.278) as the largest shift sources, and
 *                    AGENTS.md Non-Negotiable #7 forbids suppressing the ad
 *                    system — the only legal fix is reserving space, which is
 *                    bounded in what it can recover. 0.15 sits below the
 *                    six-week floor: unreachable by noise, reachable by work.
 *                    Google-good 0.10 is the successor target, not this gate.
 *
 *   LCP <= 2500 ms — a HOLD, not a target: already green at 1543 ms. It is here
 *                    because it is quietly degrading (992 -> 1541 ms since
 *                    2026-05-09) and is the obvious thing to trade away while
 *                    chasing INP. Locking it stops that trade.
 */
export const CRITERION = {
  inp: { max: 200, label: 'INP p75', unit: 'ms', baseline: 440 },
  cls: { max: 0.15, label: 'CLS p75', unit: '', baseline: 0.17 },
  lcp: { max: 2500, label: 'LCP p75', unit: 'ms', baseline: 1543 },
};

/**
 * Sustained-pass rule: the criterion must hold on the CURRENT record AND on the
 * most recent history point (a distinct 28-day window). CrUX is noisy at the
 * boundary and a single window that dips under the bar is not a fix. Two
 * consecutive windows is the same "one bad week is noise, two is real" rule the
 * existing CWV monitor already uses, applied in the passing direction.
 */
export const SUSTAINED_WINDOWS = 2;

/**
 * Interim ratchet — progress, NOT closure. #5001 does not close on this; it
 * exists so a criterion five months out still reports whether the work is
 * moving. If this is missed, the approach is not working and needs a rethink
 * rather than more of the same.
 */
export const RATCHET = { metric: 'inp', max: 300, by: '2026-10-02' };

/**
 * Per-URL watchlist. NON-BINDING (reported, never fails the run): CrUX has
 * URL-level data for only 9 of the top 60 organic landing pages, so a per-URL
 * gate would be gating on an arbitrary sample. It is here to catch
 * whack-a-mole — origin p75 improving while an individual template rots.
 *
 * Baselines measured 2026-08-07 (CrUX window 2026-07-09..2026-08-05, PHONE).
 */
export const WATCHLIST = [
  { url: `${ORIGIN}/`, inp: 322, cls: 0.10, lcp: 2319 },
  { url: `${ORIGIN}/cerca-lavoro-ticino/`, inp: 697, cls: 0.23, lcp: 1700 },
  { url: `${ORIGIN}/cerca-lavoro-svizzera/`, inp: 4085, cls: 0.46, lcp: 2001 },
  { url: `${ORIGIN}/cerca-lavoro-ticino/infermieri/`, inp: 592, cls: 0.15, lcp: 1138 },
  { url: `${ORIGIN}/cerca-lavoro-ticino/case-anziani/`, inp: 448, cls: 0.24, lcp: 948 },
];

/** A watchlist URL is flagged when it drifts this far above its own baseline. */
export const WATCHLIST_DRIFT = 1.15;

/**
 * When the WATCHLIST numbers above were measured. A hardcoded baseline silently
 * stops meaning anything once the site has moved on — drift is then computed
 * against a stale snapshot and either screams forever or never fires. There is
 * no automatic refresh on purpose (a self-updating baseline can rebaseline a
 * regression away), so instead the script says out loud when it has gone stale.
 */
export const BASELINE_DATE = '2026-08-07';
export const BASELINE_STALE_AFTER_DAYS = 120;

const METRICS = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
const KEY_OF = { lcp: 'largest_contentful_paint', inp: 'interaction_to_next_paint', cls: 'cumulative_layout_shift' };

async function crux(endpoint, body) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    console.error('PAGESPEED_API_KEY is not set. Run `source bin/rc-env.sh` locally, or `node scripts/load-rc-env.mjs` in CI.');
    process.exit(2);
  }
  const res = await fetch(`${API}/${endpoint}?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, formFactor: 'PHONE', metrics: METRICS }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, message: json?.error?.message };
}

/** CrUX returns CLS percentiles as strings and timings as numbers — normalise. */
const num = (v) => (v === undefined || v === null ? null : Number(v));

function readRecord(json) {
  const m = json?.record?.metrics;
  if (!m) return null;
  const out = { period: json.record.collectionPeriod };
  for (const [short, full] of Object.entries(KEY_OF)) {
    out[short] = num(m[full]?.percentiles?.p75);
    out[`${short}Good`] = num(m[full]?.histogram?.[0]?.density);
  }
  return out;
}

function readHistory(json) {
  const m = json?.record?.metrics;
  if (!m) return null;
  const periods = (json.record.collectionPeriods || []).map(
    (p) => `${p.lastDate.year}-${String(p.lastDate.month).padStart(2, '0')}-${String(p.lastDate.day).padStart(2, '0')}`,
  );
  const out = { periods, points: [] };
  for (let i = 0; i < periods.length; i++) {
    const pt = { end: periods[i] };
    for (const [short, full] of Object.entries(KEY_OF)) pt[short] = num(m[full]?.percentilesTimeseries?.p75s?.[i]);
    out.points.push(pt);
  }
  return out;
}

function evaluate(value, max) {
  if (value === null) return { state: 'nodata', pass: false };
  return { state: value <= max ? 'pass' : 'fail', pass: value <= max, value };
}

/**
 * The "sustained" half of the rule: pick the most recent history window that
 * ENDS STRICTLY BEFORE the current record's window.
 *
 * Do NOT assume a fixed offset into the array. The two CrUX endpoints are not
 * aligned 1:1 — measured 2026-08-07, `records:queryRecord` returned the window
 * ending 2026-08-05 while `records:queryHistoryRecord`'s last point ended
 * 2026-08-01. So `points[length - 1]` is ALREADY a distinct earlier window, and
 * the `points[length - 2]` shortcut silently skipped one (comparing against
 * 2026-07-25 / INP 402 instead of 2026-08-01 / INP 426). Comparing dates is
 * correct whatever offset the API happens to use on a given day.
 *
 * @param {Array<{end: string}>|undefined} points oldest-first history points
 * @param {{lastDate: {year: number, month: number, day: number}}|undefined} period current record period
 */
export function selectPreviousWindow(points, period) {
  if (!Array.isArray(points) || !points.length || !period?.lastDate) return null;
  const { year, month, day } = period.lastDate;
  const curEnd = Date.UTC(year, month - 1, day);
  for (let i = points.length - 1; i >= 0; i--) {
    const [y, m, d] = String(points[i].end).split('-').map(Number);
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) continue;
    if (Date.UTC(y, m - 1, d) < curEnd) return points[i];
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const asMarkdown = args.includes('--markdown');
  // `--json-out <path>` writes the machine-readable report as a side effect of
  // the SAME run that prints the human/markdown output. The workflow used to
  // invoke this script twice (once --markdown, once --json), which doubled every
  // CrUX call and, worse, swallowed a failure of the second invocation into a
  // default of `drift=0` — a real watchlist regression could then go unreported
  // with no signal at all, the exact blindness this script exists to prevent.
  const jsonOutIdx = args.indexOf('--json-out');
  const jsonOut = jsonOutIdx !== -1 ? args[jsonOutIdx + 1] : null;

  // ---- origin: the binding measurement -----------------------------------
  const cur = await crux('records:queryRecord', { origin: ORIGIN });
  if (cur.status !== 200) {
    console.error(`CrUX queryRecord failed for the origin: HTTP ${cur.status}${cur.message ? ` — ${cur.message}` : ''}`);
    console.error('Refusing to report a verdict without data. Exit 2.');
    process.exit(2);
  }
  const current = readRecord(cur.json);
  if (!current) {
    console.error('CrUX returned a 200 with no metrics for the origin. Refusing to report a verdict. Exit 2.');
    process.exit(2);
  }

  // History is only needed for the "sustained" half of the rule. If it cannot be
  // read we simply cannot prove sustained, which conservatively means NOT MET —
  // that is a verdict, not a blindness, so it must not exit 2.
  let history = null;
  try {
    const hist = await crux('records:queryHistoryRecord', { origin: ORIGIN });
    if (hist.status === 200) history = readHistory(hist.json);
    else console.error(`[warn] history unavailable (HTTP ${hist.status}) — "sustained" cannot be proven this run.`);
  } catch (err) {
    console.error(`[warn] history fetch failed (${err?.message || err}) — "sustained" cannot be proven this run.`);
  }

  const prev = selectPreviousWindow(history?.points, current.period);

  const results = {};
  for (const [short, spec] of Object.entries(CRITERION)) {
    const now = evaluate(current[short], spec.max);
    const before = prev ? evaluate(prev[short], spec.max) : { state: 'nodata', pass: false };
    results[short] = {
      ...spec,
      current: current[short],
      currentGood: current[`${short}Good`],
      previous: prev ? prev[short] : null,
      previousEnd: prev ? prev.end : null,
      passNow: now.pass,
      passPrev: before.pass,
      sustained: now.pass && before.pass,
      deltaToTarget: current[short] === null ? null : +(current[short] - spec.max).toFixed(3),
    };
  }

  const bindingPass = Object.values(results).every((r) => r.sustained);

  // ---- ratchet ------------------------------------------------------------
  const ratchetSpec = CRITERION[RATCHET.metric];
  const ratchet = {
    ...RATCHET,
    label: ratchetSpec.label,
    current: current[RATCHET.metric],
    pass: current[RATCHET.metric] !== null && current[RATCHET.metric] <= RATCHET.max,
    overdue: new Date() > new Date(`${RATCHET.by}T00:00:00Z`),
  };

  // ---- watchlist ----------------------------------------------------------
  // Every fetch here is wrapped: the watchlist is NON-BINDING and is read AFTER
  // the binding origin verdict is already computed. Letting a transient network
  // error on one of these URLs escape would reach main().catch() and exit 2,
  // throwing away a perfectly good binding verdict and opening the
  // "criterion unreadable" issue — the opposite of the narrow issue policy this
  // script exists to enforce. A failed watchlist entry is `available: false`.
  const watch = [];
  for (const entry of WATCHLIST) {
    let r;
    try {
      r = await crux('records:queryRecord', { url: entry.url });
    } catch (err) {
      watch.push({ url: entry.url, available: false, note: `fetch failed: ${err?.message || err}` });
      continue;
    }
    if (r.status !== 200) {
      watch.push({ url: entry.url, available: false, note: r.status === 404 ? 'no CrUX data (below reporting threshold)' : `HTTP ${r.status}` });
      continue;
    }
    const rec = readRecord(r.json);
    if (!rec) {
      watch.push({ url: entry.url, available: false, note: '200 with no metrics' });
      continue;
    }
    const row = { url: entry.url, available: true, drift: [] };
    for (const short of ['inp', 'cls', 'lcp']) {
      row[short] = rec[short];
      const base = entry[short];
      if (rec[short] !== null && base && rec[short] > base * WATCHLIST_DRIFT) {
        row.drift.push(`${short.toUpperCase()} ${rec[short]} vs baseline ${base} (+${Math.round((rec[short] / base - 1) * 100)}%)`);
      }
    }
    watch.push(row);
  }

  const baselineAgeDays = Math.floor((Date.now() - Date.parse(`${BASELINE_DATE}T00:00:00Z`)) / 864e5);
  const baselineStale = baselineAgeDays > BASELINE_STALE_AFTER_DAYS;
  if (baselineStale) {
    console.error(`[warn] the watchlist baselines are ${baselineAgeDays} days old (measured ${BASELINE_DATE}). Drift is being compared against a stale snapshot — re-measure and update WATCHLIST + BASELINE_DATE deliberately.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baselineDate: BASELINE_DATE,
    baselineAgeDays,
    baselineStale,
    source: 'CrUX API records:queryRecord + records:queryHistoryRecord, formFactor PHONE',
    origin: ORIGIN,
    collectionPeriod: current.period,
    criterion: results,
    sustainedWindows: SUSTAINED_WINDOWS,
    bindingPass,
    ratchet,
    watchlist: watch,
    verdict: bindingPass ? 'MET' : 'NOT MET',
  };

  if (jsonOut) {
    // Let a write failure be fatal-by-exception rather than silently producing
    // no file: the caller reads this to decide whether to raise a drift issue.
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(bindingPass ? 0 : 1);
  }

  // CLS is unitless and needs decimals; the timings are integers in ms.
  const fmt = (v, unit) => {
    if (v === null) return 'no data';
    const body = Number.isInteger(v) ? String(v) : v.toFixed(2);
    return unit ? `${body} ${unit}` : body;
  };
  const mark = (ok) => (ok ? 'PASS' : 'FAIL');
  const lines = [];
  const p = (s) => lines.push(s);

  const period = current.period;
  const pd = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

  if (asMarkdown) {
    p(`### Criterio di campo #5001 — **${report.verdict}**`);
    p('');
    p(`Fonte: CrUX API, \`formFactor: PHONE\`, origine \`${ORIGIN}\`, p75.`);
    p(`Finestra corrente: ${pd(period.firstDate)} → ${pd(period.lastDate)}. Letto il ${report.generatedAt.slice(0, 10)}.`);
    p('');
    p('| Metrica | Soglia | Finestra corrente | Finestra precedente | Sostenuto |');
    p('|---|---|---|---|---|');
    for (const r of Object.values(results)) {
      p(`| ${r.label} | ≤ ${fmt(r.max, r.unit)} | ${fmt(r.current, r.unit)}${r.currentGood !== null ? ` (${Math.round(r.currentGood * 100)}% buone)` : ''} | ${fmt(r.previous, r.unit)}${r.previousEnd ? ` (→${r.previousEnd})` : ''} | ${mark(r.sustained)} |`);
    }
    p('');
    p(`Ratchet intermedio (progresso, non chiusura): ${ratchet.label} ≤ ${ratchet.max} ms entro ${ratchet.by} — attuale ${fmt(ratchet.current, 'ms')}, ${mark(ratchet.pass)}${ratchet.overdue && !ratchet.pass ? ' **(scaduto)**' : ''}.`);
    p('');
    const flagged = watch.filter((w) => w.available && w.drift.length);
    p(`Watchlist per-URL (informativa): ${watch.filter((w) => w.available).length}/${watch.length} con dati CrUX, ${flagged.length} in deriva oltre +${Math.round((WATCHLIST_DRIFT - 1) * 100)}% dalla baseline 2026-08-07.`);
    for (const w of flagged) p(`- \`${w.url.replace(ORIGIN, '')}\` — ${w.drift.join('; ')}`);
    console.log(lines.join('\n'));
    process.exit(bindingPass ? 0 : 1);
  }

  p('');
  p(`CWV field criterion for issue #5001 — ${report.verdict}`);
  p(`  source : CrUX PHONE p75, origin ${ORIGIN}`);
  p(`  window : ${pd(period.firstDate)} .. ${pd(period.lastDate)}  (trailing 28 days)`);
  p('');
  p(`  ${'metric'.padEnd(10)}${'target'.padStart(10)}${'current'.padStart(12)}${'previous'.padStart(12)}${'sustained'.padStart(12)}`);
  p(`  ${'-'.repeat(56)}`);
  for (const r of Object.values(results)) {
    p(`  ${r.label.padEnd(10)}${("<= " + r.max).padStart(10)}${fmt(r.current, "").padStart(12)}${fmt(r.previous, "").padStart(12)}${mark(r.sustained).padStart(12)}`);
  }
  p('');
  p(`  ratchet: ${ratchet.label} <= ${ratchet.max} ms by ${ratchet.by} — now ${fmt(ratchet.current, 'ms')} [${mark(ratchet.pass)}]${ratchet.overdue && !ratchet.pass ? '  OVERDUE' : ''}`);
  p('');
  p('  watchlist (informational, never fails the run):');
  for (const w of watch) {
    if (!w.available) { p(`    ${w.url.replace(ORIGIN, '').padEnd(42)} ${w.note}`); continue; }
    const flag = w.drift.length ? `DRIFT: ${w.drift.join('; ')}` : 'within baseline';
    p(`    ${w.url.replace(ORIGIN, '').padEnd(42)} INP ${String(w.inp ?? '-').padStart(5)}  CLS ${w.cls === null ? '  -' : w.cls.toFixed(2)}  LCP ${String(w.lcp ?? '-').padStart(5)}  ${flag}`);
  }
  p('');
  console.log(lines.join('\n'));
  process.exit(bindingPass ? 0 : 1);
}

// Only run when invoked as a CLI. Importing this module (tests, other scripts)
// must never fire a live CrUX call — same guard as scripts/cwv-monitor-check.mjs
// and scripts/posthog-error-issue-sync.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('check-cwv-field-criterion failed:', err?.stack || err);
    // Exit 2, not 1: an unexpected throw is "no verdict", not "criterion failed".
    process.exit(2);
  });
}

export { main };
