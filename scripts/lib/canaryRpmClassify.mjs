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

const RPM_LABELS = { metric: 'RPM', confirm: 'Earnings', volumeNoun: 'page-view', volumeAbbrev: 'pv', decimals: 2 };

/**
 * @typedef {{ date: string, rpm: number, earnings: number, pageViews: number }} DailyRow
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
