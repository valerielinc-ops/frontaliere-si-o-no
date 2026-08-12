/**
 * seo-ctr-curve.mjs — shared expected-CTR-by-position model + template
 * family registry for the SERP CTR pipeline (issue #4300).
 *
 * Single source of truth used by BOTH scripts/seo-ctr-baseline.mjs (one-off
 * gap analysis) and scripts/monitor-seo-ctr-by-template.mjs (scheduled
 * threshold monitor) — per AGENTS.md sibling-pattern discipline, the
 * expected-CTR curve and the family prefix list must never drift between
 * the two call sites.
 *
 * The curve is a blended organic CTR-by-position benchmark (rounded from
 * publicly published organic CTR studies, e.g. Advanced Web Ranking /
 * Backlinko aggregate curves). It is intentionally coarse — this is a
 * "is this family systematically underperforming its position" signal,
 * not a precise per-query prediction.
 *
 * The weighted-position/CTR ratio math reuses
 * scripts/lib/analytics-opportunity-utils.mjs's weightedAveragePosition() /
 * computeCtr() — the same divide-by-zero-guarded formula
 * aggregateRowsByTemplate() there uses, extracted so the two independent
 * GSC row-aggregation call sites can't drift apart.
 */

import { weightedAveragePosition, computeCtr } from './analytics-opportunity-utils.mjs';

// Index 0 unused — GSC positions are 1-based. Values are CTR fractions
// (0.316 === 31.6%).
const CTR_BY_POSITION = [
  null,
  0.316, 0.155, 0.106, 0.072, 0.056,
  0.044, 0.037, 0.032, 0.028, 0.025,
  0.022, 0.019, 0.017, 0.015, 0.013,
  0.012, 0.011, 0.010, 0.009, 0.008,
];
const TAIL_CTR = 0.006; // position > 20

/** Expected organic CTR (fraction, e.g. 0.037) for a given average position. */
export function expectedCtrForPosition(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p < 1) return CTR_BY_POSITION[1];
  const idx = Math.round(p);
  if (idx >= 1 && idx < CTR_BY_POSITION.length) return CTR_BY_POSITION[idx];
  return TAIL_CTR;
}

/**
 * Ratio of actual to expected CTR at a given position. <1 = underperforming
 * the position curve, >1 = overperforming. Returns null when position is
 * not a finite number (can't evaluate).
 */
export function ctrGapRatio(actualCtr, position) {
  const expected = expectedCtrForPosition(position);
  if (!expected) return null;
  return Number(actualCtr) / expected;
}

/**
 * MIN_IMPRESSIONS_TO_MONITOR — the volume above which a TEMPLATE family must
 * be monitored. Enforced by tests/seo-ctr-curve.test.ts against the measured
 * `impressions90d` recorded on each entry, so a high-volume family cannot be
 * silently left out of the monitor again (it already happened once: see the
 * `cerca-lavoro-ticino` entry below).
 *
 * 50k impressions / 90 days ≈ 555/day. Below that a 14-day window carries too
 * few impressions for the weekly check to distinguish a real CTR drop from
 * noise; above it, a single point of CTR is worth thousands of clicks a
 * quarter and the family has to be watched.
 */
export const MIN_IMPRESSIONS_TO_MONITOR = 50_000;

/**
 * Template families targeted by issue #4300, plus the `/de/` locale prefix
 * kept as a report-only reference.
 *
 * FIELDS
 *   kind          'template' = one page template with its own title/description
 *                 generator, i.e. something the monitor's remediation advice can
 *                 actually point at. 'locale' = a cross-cutting language prefix
 *                 that aggregates pages of EVERY template; its CTR cannot be
 *                 attributed to any one generator, so it is exempt from the
 *                 monitored-above-threshold invariant. The test pins `locale` to
 *                 an actual `/xx/` locale root so the exemption cannot be used
 *                 to dodge the invariant by relabelling a template family.
 *   impressions90d  measured GSC impressions over a trailing 90 days — the input
 *                 to the invariant. `measuredOn` records when.
 *   targetCtr     absolute CTR floor (fraction). Used as-is when the family
 *                 declares no curve multiple, and as the fallback when GSC
 *                 returns no usable average position.
 *   targetCtrCurveMultiple  when set, the effective target is
 *                 `multiple × expectedCtrForPosition(avgPosition)` — see
 *                 effectiveTargetCtr() below.
 */
export const SEO_CTR_FAMILIES = [
  {
    id: 'articoli-frontaliere',
    label: 'Articoli (blog)',
    pathContains: '/articoli-frontaliere/',
    kind: 'template',
    targetCtr: 0.03,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08, dataState final: 242.986 imp, CTR 2,03%, pos 7,56.
    impressions90d: 242986,
    measuredOn: '2026-08-11',
  },
  {
    id: 'guida-frontaliere',
    label: 'Guida frontaliere',
    pathContains: '/guida-frontaliere/',
    kind: 'template',
    targetCtr: 0.035,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08: 84.951 imp, 1.773 click, CTR 2,09%, pos 9,51.
    impressions90d: 84951,
    measuredOn: '2026-08-11',
  },
  {
    id: 'tasse-e-pensione',
    label: 'Tasse e pensione',
    pathContains: '/tasse-e-pensione/',
    kind: 'template',
    targetCtr: 0.03,
    monitored: true,
    // GSC 2026-05-13 → 2026-08-08: 45.387 imp, 670 click, CTR 1,48%, pos 6,76.
    // Under MIN_IMPRESSIONS_TO_MONITOR but monitored anyway — the invariant is
    // a floor on what MUST be watched, not a ceiling on what may be.
    impressions90d: 45387,
    measuredOn: '2026-08-11',
  },
  {
    // The single highest-value family on the property, and it sat here with
    // `monitored: false, targetCtr: null` from #4300 onward because the issue
    // cited it as a healthy *benchmark*. Measured 2026-08-11 over GSC
    // 2026-05-13 → 2026-08-08 (dataState final): 911.138 impressioni, 60.373
    // click, CTR 6,63%, posizione media ponderata 8,61 — 2,4× le impressioni e
    // 3,4× i click pesati delle tre famiglie sorvegliate MESSE INSIEME, su
    // pubblico svizzero (CPC 0,17 contro 0,05 dell'italiano). Un punto di CTR
    // qui vale ~9.111 click / 90gg ≈ 3.037 al mese. Non sorvegliarla era la
    // cosa più costosa che questo registro potesse fare.
    id: 'cerca-lavoro-ticino', // cathedral-allow: GSC family identifier for CTR aggregation, not a URL emission site
    label: 'Cerca lavoro Ticino',
    pathContains: '/cerca-lavoro-ticino/',
    kind: 'template',
    monitored: true,
    // WHY NOT 0.035 like the Italian families: at 6,63% a 3,50% floor is 47%
    // below where the family lives — it could never fire, and an alarm that
    // cannot fire is decoration. WHY NOT the raw position curve either: at
    // position 8,61 the generic organic benchmark expects 2,8%, so this family
    // already beats its position by 2,37× (Swiss job-search intent) and 2,8%
    // would be even more ornamental than 3,50%.
    // So the target is expressed on the family's OWN position↔CTR curve:
    // 80% of the demonstrated 2,37× ratio → 1,9× the position-expected CTR.
    // Today that is 1,9 × 2,8% = 5,32%, i.e. the monitor escalates after a
    // ~20% CTR regression sustained for 2 consecutive weekly runs. Because the
    // target moves with the measured position, a pure ranking loss does NOT
    // fire it — that is deliberate: this monitor answers "is the snippet still
    // earning its position", which is the question its remediation advice
    // (title/description generators) can actually act on.
    targetCtrCurveMultiple: 1.9,
    // Fallback floor when GSC gives no usable position: 80% of the measured
    // 6,63%, the same 20%-regression trigger expressed as an absolute.
    targetCtr: 0.053,
    impressions90d: 911138,
    measuredOn: '2026-08-11',
  },
  {
    id: 'de',
    label: 'DE locale (riferimento)',
    pathContains: '/de/',
    // Locale prefix, not a template: `/de/` aggregates the German variant of
    // every family at once, so a CTR reading here cannot be attributed to any
    // single description generator and the issue the monitor would open would
    // have no actionable path. Report-only by construction.
    kind: 'locale',
    targetCtr: null,
    monitored: false,
    // GSC 2026-05-13 → 2026-08-08: 518.608 imp, 18.541 click, CTR 3,58%, pos 12,52.
    impressions90d: 518608,
    measuredOn: '2026-08-11',
  },
];

/**
 * The CTR floor a family is actually judged against on a given run.
 *
 * When the family declares `targetCtrCurveMultiple` AND the run produced a
 * usable weighted average position, the floor is derived from the position
 * curve — `multiple × expectedCtrForPosition(avgPosition)` — so the threshold
 * follows the family instead of being a number frozen in a file. Otherwise the
 * static `targetCtr` is used, which is what the three #4300 families still do.
 *
 * Shared by scripts/monitor-seo-ctr-by-template.mjs and
 * scripts/seo-ctr-baseline.mjs for the same sibling-pattern reason the curve
 * itself is shared: the two call sites must not disagree on what "below
 * target" means.
 *
 * Returns null when the family has no target at all (report-only families).
 */
export function effectiveTargetCtr(family, avgPosition) {
  if (!family) return null;
  const multiple = Number(family.targetCtrCurveMultiple);
  const position = Number(avgPosition);
  if (Number.isFinite(multiple) && multiple > 0 && Number.isFinite(position) && position >= 1) {
    const expected = expectedCtrForPosition(position);
    if (expected) return multiple * expected;
  }
  return family.targetCtr ?? null;
}

// Locale prefixes stripped before segmenting a path into a candidate family,
// same set the `locale`-kind exemption in SEO_CTR_FAMILIES is pinned to
// (`/en/`, `/de/`, `/fr/` — Italian has no prefix, it's the default locale).
const LOCALE_PATH_PREFIXES = new Set(['en', 'de', 'fr']);

/**
 * Discover path segments carrying MIN_IMPRESSIONS_TO_MONITOR+ impressions
 * that aren't covered by any `pathContains` already in the registry —
 * the automated version of what issue #4300 did by hand for
 * `/cerca-lavoro-ticino/` (911k impressions/90gg, invisible to the monitor
 * for years). Pure function: takes raw GSC page rows in, returns candidates
 * out, no I/O — the GSC fetch + issue-opening side effects live in
 * scripts/monitor-seo-ctr-by-template.mjs.
 *
 * `pageRows` — [{ path, impressions }], one entry per indexed page (locale
 * prefix included, e.g. `/en/cerca-lavoro-ticino/some-slug/`). A page's
 * impressions roll up into the segment right after its locale prefix (if
 * any), mirroring how the registry's substring `pathContains` already
 * aggregates every locale of a template into one family.
 */
export function discoverUnregisteredFamilies(pageRows, {
  families = SEO_CTR_FAMILIES,
  minImpressions = MIN_IMPRESSIONS_TO_MONITOR,
} = {}) {
  const registeredPrefixes = new Set(families.map((f) => f.pathContains));
  const bySegment = new Map();

  for (const row of pageRows || []) {
    const path = row?.path;
    if (typeof path !== 'string' || !path) continue;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const segment = LOCALE_PATH_PREFIXES.has(parts[0]) ? parts[1] : parts[0];
    if (!segment) continue;
    const prefix = `/${segment}/`;
    if (registeredPrefixes.has(prefix)) continue;
    bySegment.set(prefix, (bySegment.get(prefix) || 0) + Number(row.impressions || 0));
  }

  return [...bySegment.entries()]
    .filter(([, impressions]) => impressions >= minImpressions)
    .map(([pathContains, impressions90d]) => ({ pathContains, impressions90d }))
    .sort((a, b) => b.impressions90d - a.impressions90d);
}

/**
 * Aggregate a list of GSC page rows ({clicks, impressions, ctr, position})
 * into family-level weighted metrics + a below-curve-page breakdown.
 * `underperformRatio` (default 0.6) flags pages whose actual CTR is below
 * that fraction of the position-expected CTR.
 */
export function aggregateFamilyRows(rows, { underperformRatio = 0.6, minImpressions = 20 } = {}) {
  const eligible = rows.filter((r) => Number(r.impressions || 0) >= minImpressions);
  const totalClicks = eligible.reduce((sum, r) => sum + Number(r.clicks || 0), 0);
  const totalImpressions = eligible.reduce((sum, r) => sum + Number(r.impressions || 0), 0);
  const weightedPositionSum = eligible.reduce((sum, r) => sum + Number(r.position || 0) * Number(r.impressions || 0), 0);
  const weightedPosition = totalImpressions > 0
    ? weightedAveragePosition(weightedPositionSum, totalImpressions)
    : null;
  const avgCtr = totalImpressions > 0 ? computeCtr(totalClicks, totalImpressions) : null;

  const belowCurve = eligible
    .map((r) => ({
      ...r,
      expectedCtr: expectedCtrForPosition(r.position),
      gapRatio: ctrGapRatio(r.ctr, r.position),
    }))
    .filter((r) => r.gapRatio !== null && r.gapRatio < underperformRatio)
    .sort((a, b) => Number(b.impressions || 0) - Number(a.impressions || 0));

  return {
    pageCount: eligible.length,
    totalClicks,
    totalImpressions,
    avgCtr,
    avgPosition: weightedPosition,
    belowCurveCount: belowCurve.length,
    belowCurvePages: belowCurve,
  };
}
