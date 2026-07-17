/**
 * arpuCanaryClassify.mjs — ARPU-regression classifier for the user-value
 * canary (scripts/canary-user-value.mjs). Sibling of
 * scripts/lib/canaryRpmClassify.mjs, both thin domain-flavored wrappers
 * over the shared scripts/lib/canaryRegressionClassify.mjs baseline-window
 * + two-signal-gate core.
 *
 * ARPU (totalAdRevenue ÷ activeUsers) is a ratio, exactly like RPM
 * (earnings ÷ pageViews) — a spike in `activeUsers` with flat revenue
 * halves ARPU without a cent of lost revenue, the same denominator-only
 * false alarm the RPM canary's earnings gate was built to silence (issue
 * #2176). Mirroring that gate here: only declare a regression when the
 * ARPU ratio drops AND same-day revenue also drops vs its own baseline.
 *
 * Unlike RPM (a CHF/day figure with years of history to calibrate an
 * absolute floor), the 3 new user-scoped GA4 dimensions this metric will
 * eventually segment by only went live 2026-07-17 — there isn't yet a
 * settled ARPU range to hang an absolute floor on. `DEFAULT_ABSOLUTE_FLOOR`
 * is left at the generic module's disabled default (0) so this canary
 * starts ratio-only; revisit once a few weeks of history exist.
 */

import {
  classifyRegression,
  latestClosedIndex as genericLatestClosedIndex,
} from './canaryRegressionClassify.mjs';

export const DEFAULT_RATIO_FLOOR = 0.65;
export const DEFAULT_ABSOLUTE_FLOOR = 0; // disabled — no calibrated ARPU floor yet, see module docstring
export const DEFAULT_REVENUE_FLOOR = 0.65;
export const BASELINE_DAYS = 7;
export const BASELINE_LAG_DAYS = 3; // baseline ends at T-3 (skips noisy last days)
export const REQUIRED_BASELINE_SAMPLES = 5; // need at least 5 days of baseline data

const ARPU_LABELS = { metric: 'ARPU', confirm: 'Revenue', volumeNoun: 'active-user', volumeAbbrev: 'users', decimals: 4 };

/**
 * @typedef {{ date: string, arpu: number, revenue: number, activeUsers: number }} DailyRow
 */

/**
 * Pick the latest fully-closed day. The current UTC day (`todayUtc`) is
 * never closed — drop it and anything after it. Then, defensively, if the
 * resulting candidate's active-users count looks truncated (< 50% of the
 * day before), step back one more in case GA4 hasn't settled yesterday yet.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {string|undefined} todayUtc YYYY-MM-DD of the current UTC day
 * @returns {number} index of the latest closed row (may be -1 if none)
 */
export function latestClosedIndex(rows, todayUtc) {
  return genericLatestClosedIndex(
    rows.map((r) => ({ date: r.date, volume: r.activeUsers })),
    todayUtc,
  );
}

/**
 * Classify the daily ARPU rows into healthy / regression / insufficient-data.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {{ ratioFloor?: number, absoluteFloor?: number, revenueFloor?: number, todayUtc?: string }} [opts]
 */
export function classifyArpu(rows, opts = {}) {
  const generic = classifyRegression(
    rows.map((r) => ({ date: r.date, value: r.arpu, confirm: r.revenue, volume: r.activeUsers })),
    {
      ratioFloor: opts.ratioFloor ?? DEFAULT_RATIO_FLOOR,
      absoluteFloor: opts.absoluteFloor ?? DEFAULT_ABSOLUTE_FLOOR,
      confirmFloor: opts.revenueFloor ?? DEFAULT_REVENUE_FLOOR,
      todayUtc: opts.todayUtc,
      labels: ARPU_LABELS,
    },
  );

  if (generic.verdict === 'insufficient-data') return generic;

  return {
    verdict: generic.verdict,
    current: {
      date: generic.current.date,
      arpu: generic.current.value,
      revenue: generic.current.confirm,
      activeUsers: generic.current.volume,
    },
    baseline: {
      from: generic.baseline.from,
      to: generic.baseline.to,
      arpu: generic.baseline.value,
      revenue: generic.baseline.confirm,
      samples: generic.baseline.samples,
    },
    ratio: generic.ratio,
    revenueRatio: generic.confirmRatio,
    floors: { ratio: generic.floors.ratio, absoluteEUR: generic.floors.absolute, revenue: generic.floors.confirm },
    reasons: generic.reasons,
    ...(generic.note ? { note: generic.note } : {}),
  };
}
