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
 * Two correctness properties this encodes — both born from real false
 * alarms (issue #2176, 2026-06-15..17):
 *
 *   1. NEVER measure the still-open current UTC day. AdSense reports a row
 *      for "today" the moment it has any data, but that day's EARNINGS are
 *      far from final, so its RPM reads artificially low. The old PV-only
 *      "is the last row complete?" heuristic (drop if PV < 50% of prior)
 *      failed on high-traffic mornings: on 2026-06-15 the still-open day's
 *      partial PV already exceeded half of the prior day, so the canary
 *      compared TODAY (incomplete) against the baseline and cried wolf.
 *      Fix: when `todayUtc` is known, any row dated >= today is dropped
 *      outright, then the PV-completeness guard still trims a yesterday
 *      that looks like it is still settling.
 *
 *   2. RPM is a RATIO (earnings ÷ page views). A page-view SPIKE with
 *      perfectly healthy earnings halves RPM mechanically — that is benign
 *      traffic (often bot/AI crawl or a Discover hit), NOT a revenue
 *      incident. On 2026-06-15 earnings were normal (5.46 CHF, in line with
 *      4.4–5.7 the surrounding days) while PV spiked to 3625 (~2.4×), so
 *      RPM "crashed" to 1.51 with zero lost revenue. A real incident
 *      (the 2026-05-28 stub regression that birthed this canary) instead
 *      collapses EARNINGS because no ads serve. Fix: only declare a
 *      regression when the RPM signal fires AND current-day earnings are
 *      also materially below the baseline earnings. This preserves the
 *      2026-05-28 catch (earnings cratered) while silencing PV-spike dips.
 *
 * A third property, added after issue #4610 (2026-07-20..25): the two rules
 * above only catch an ACUTE regression — one that stands out against a
 * trailing 7-day baseline (T-9..T-3). #4610 fired once (2026-07-20, RPM
 * 3.15→0.24) and self-closed the next day because that single day "rolled
 * back into" the comparison window. From then on every run stayed green
 * even though the underlying problem (bot/scraper traffic diluting ad
 * requests) kept getting worse for weeks — AdSense account-level
 * AD_REQUESTS_COVERAGE fell 58%→41%→21% June→August 2026. A MOVING
 * baseline that is itself built from the last 7-9 degraded days adapts to
 * the new (bad) level, so the day-over-day ratio stops showing any
 * contrast: a classic "baseline chasing the regression" blind spot that no
 * short moving window can see by construction.
 *
 * `classifyCoverage` closes that gap with a check that is deliberately NOT
 * baseline-relative: AD_REQUESTS_COVERAGE (the fraction of ad requests that
 * were actually filled) compared against a fixed absolute floor, averaged
 * over a short trailing window of fully-closed days so one noisy day can't
 * trip it. Because the floor never moves, it cannot be "adapted to" by a
 * sustained drift the way the RPM/earnings baseline can.
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

// Coverage floor (issue #4610 fix): AD_REQUESTS_COVERAGE is a fraction
// (0..1) of ad requests AdSense actually filled. Historical (Jan-Jun 2026)
// daily coverage sat at 56-67%; by August 2026 monthly account coverage had
// fallen to 21%. 0.45 sits comfortably below the healthy range so it does
// not fire on normal noise, but above the 41% already seen in July —
// catching the drift roughly a month earlier than waiting for it to reach
// the ~21% territory the ratio/earnings gate above still wouldn't flag
// (because by then the 7-day RPM baseline has adapted to the bad level too).
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
 * the window is treated as missing data, not as 0% coverage.
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
  if (values.some((v) => !Number.isFinite(v))) {
    return { verdict: 'insufficient-data', reason: 'coverage data missing for one or more days in the window' };
  }

  const avgCoverage = values.reduce((s, v) => s + v, 0) / values.length;
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
