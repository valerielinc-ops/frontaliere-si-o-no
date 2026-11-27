/**
 * canaryRpmClassify.mjs — pure RPM-regression classifier for the AdSense
 * RPM canary (scripts/canary-rpm.mjs). Extracted into a lib so it can be
 * unit-tested without the AdSense API / OAuth round-trip.
 *
 * Thin RPM-flavored wrapper over the generic dual-signal classifier in
 * scripts/lib/canaryRegressionClassify.mjs (shared with the ARPU canary,
 * scripts/lib/arpuCanaryClassify.mjs) — same baseline-window math and
 * two-signal gate, RPM-specific defaults/labels/output shape only. Public
 * API and returned object shape are unchanged from before this extraction.
 *
 * The classifier excludes the unsettled current day, requires the RPM and
 * earnings signals together, and also checks ad-request coverage against a
 * fixed floor. The coverage check complements the moving baseline when a
 * decline persists.
 */

import {
  classifyRegression,
  latestClosedIndex as genericLatestClosedIndex,
} from './canaryRegressionClassify.mjs';

export const DEFAULT_RATIO_FLOOR = 0.65;
export const DEFAULT_ABSOLUTE_FLOOR = 1.0;
export const DEFAULT_EARNINGS_FLOOR = 0.65;
export const BASELINE_DAYS = 7;
export const BASELINE_LAG_DAYS = 3; // baseline ends at T-3 (skips noisy last days)
export const REQUIRED_BASELINE_SAMPLES = 5; // need at least 5 days of baseline data

// Keep coverage comparison independent of the moving RPM baseline.
export const DEFAULT_COVERAGE_FLOOR = 0.45;
// Require the floor breach to hold over several consecutive closed days —
// "sustained", not a single bad day (that acute case is already covered by
// the RPM+earnings gate above). 3 days keeps detection latency low while
// filtering one-off noise.
export const COVERAGE_SUSTAIN_DAYS = 3;

const RPM_LABELS = { metric: 'RPM', confirm: 'Earnings', volumeNoun: 'page-view', volumeAbbrev: 'pv', decimals: 2 };

/**
 * @typedef {{ date: string, rpm: number, earnings: number, pageViews: number, coverage?: number }} DailyRow
 */

/**
 * Pick the latest fully-closed day. The current UTC day (`todayUtc`) is
 * never closed — drop it and anything after it. Then, defensively, if the
 * resulting candidate's page views look truncated (< 50% of the day
 * before), step back one more in case AdSense hasn't settled yesterday yet.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {string|undefined} todayUtc YYYY-MM-DD of the current UTC day
 * @returns {number} index of the latest closed row (may be -1 if none)
 */
export function latestClosedIndex(rows, todayUtc) {
  return genericLatestClosedIndex(
    rows.map((r) => ({ date: r.date, volume: r.pageViews })),
    todayUtc,
  );
}

/**
 * Classify the daily RPM rows into healthy / regression / insufficient-data.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {{ ratioFloor?: number, absoluteFloor?: number, earningsFloor?: number, todayUtc?: string }} [opts]
 */
export function classifyRpm(rows, opts = {}) {
  const generic = classifyRegression(
    rows.map((r) => ({ date: r.date, value: r.rpm, confirm: r.earnings, volume: r.pageViews })),
    {
      ratioFloor: opts.ratioFloor ?? DEFAULT_RATIO_FLOOR,
      absoluteFloor: opts.absoluteFloor ?? DEFAULT_ABSOLUTE_FLOOR,
      confirmFloor: opts.earningsFloor ?? DEFAULT_EARNINGS_FLOOR,
      todayUtc: opts.todayUtc,
      labels: RPM_LABELS,
    },
  );

  if (generic.verdict === 'insufficient-data') return generic;

  return {
    verdict: generic.verdict,
    current: {
      date: generic.current.date,
      rpm: generic.current.value,
      earnings: generic.current.confirm,
      pageViews: generic.current.volume,
    },
    baseline: {
      from: generic.baseline.from,
      to: generic.baseline.to,
      rpm: generic.baseline.value,
      earnings: generic.baseline.confirm,
      samples: generic.baseline.samples,
    },
    ratio: generic.ratio,
    earningsRatio: generic.confirmRatio,
    floors: { ratio: generic.floors.ratio, absoluteCHF: generic.floors.absolute, earnings: generic.floors.confirm },
    reasons: generic.reasons,
    ...(generic.note ? { note: generic.note } : {}),
  };
}

/**
 * Classify sustained AD_REQUESTS_COVERAGE degradation — the complementary,
 * NON-baseline-relative check described in the module docstring (issue
 * #4610). Averages `coverage` (fraction 0..1) over the last `sustainDays`
 * fully-closed days and compares it against a fixed floor. Unlike
 * `classifyRpm`, this has nothing to "adapt to": the floor never moves, so
 * a degradation that has already dragged the RPM/earnings moving baseline
 * down with it still shows up here.
 *
 * Intentionally uses the SAME `latestClosedIndex` (pageViews-based
 * still-open/truncated-day guard) as `classifyRpm` so both checks agree on
 * which days are "closed" — a row missing `coverage` (undefined/NaN) inside
 * the window is treated as missing data, not as 0% coverage, and is excluded
 * from the average rather than zeroing out the whole window (tolerates one
 * missing day; two or more falls back to `insufficient-data`).
 *
 * @param {DailyRow[]} rows ascending by date (needs `date`, `pageViews`,
 *   `coverage`)
 * @param {{ coverageFloor?: number, sustainDays?: number, todayUtc?: string }} [opts]
 */
export function classifyCoverage(rows, opts = {}) {
  const coverageFloor = opts.coverageFloor ?? DEFAULT_COVERAGE_FLOOR;
  const sustainDays = opts.sustainDays ?? COVERAGE_SUSTAIN_DAYS;
  const todayUtc = opts.todayUtc;

  const closedIdx = latestClosedIndex(rows, todayUtc);
  if (closedIdx < 0 || closedIdx + 1 < sustainDays) {
    return {
      verdict: 'insufficient-data',
      reason: `need ${sustainDays} fully-closed day(s) of coverage data, got ${Math.max(closedIdx + 1, 0)}`,
    };
  }

  const window = rows.slice(closedIdx - sustainDays + 1, closedIdx + 1);
  const values = window.map((r) => (typeof r.coverage === 'number' ? r.coverage : NaN));
  const validValues = values.filter((v) => Number.isFinite(v));
  // Tolerate at most one missing/NaN day (an isolated AdSense API hiccup) —
  // average over the remaining valid days instead of zeroing out the whole
  // check. Requiring ALL days to be valid let a single missing day mask a
  // real sustained regression (issue #6499, a variant of the #4610 blind
  // spot this check exists to close). Two or more missing days means the
  // window itself is unreliable, not just noisy.
  const minValidDays = Math.max(1, sustainDays - 1);
  if (validValues.length < minValidDays) {
    return {
      verdict: 'insufficient-data',
      reason:
        `coverage data missing for ${values.length - validValues.length} of ${values.length} day(s) ` +
        `in the window (need at least ${minValidDays} valid)`,
    };
  }

  const avgCoverage = validValues.reduce((s, v) => s + v, 0) / validValues.length;
  const isRegression = avgCoverage < coverageFloor;
  const pct = (n) => (n * 100).toFixed(0);

  const result = {
    verdict: isRegression ? 'coverage-regression' : 'healthy',
    window: { from: window[0].date, to: window[window.length - 1].date, days: window.length },
    coverage: window.map((r, i) => ({ date: r.date, coverage: values[i] })),
    avgCoverage: Number(avgCoverage.toFixed(4)),
    floor: coverageFloor,
    reasons: [],
  };
  if (isRegression) {
    result.reasons.push(
      `AD_REQUESTS_COVERAGE averaged ${pct(avgCoverage)}% over the last ${sustainDays} closed days ` +
        `(${window.map((r, i) => `${r.date}=${pct(values[i])}%`).join(', ')}) — below the ${pct(coverageFloor)}% ` +
        `absolute floor. Sustained low coverage; not caught by the RPM/earnings gate because a degradation this ` +
        `long has already been absorbed into its own 7-day baseline (see issue #4610).`,
    );
  }
  return result;
}
