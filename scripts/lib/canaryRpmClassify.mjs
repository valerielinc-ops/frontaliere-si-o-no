/**
 * canaryRpmClassify.mjs — pure RPM-regression classifier for the AdSense
 * RPM canary (scripts/canary-rpm.mjs). Extracted into a lib so it can be
 * unit-tested without the AdSense API / OAuth round-trip.
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

export const DEFAULT_RATIO_FLOOR = 0.65;
export const DEFAULT_ABSOLUTE_FLOOR = 1.0;
export const DEFAULT_EARNINGS_FLOOR = 0.65;
export const BASELINE_DAYS = 7;
export const BASELINE_LAG_DAYS = 3; // baseline ends at T-3 (skips noisy last days)
export const REQUIRED_BASELINE_SAMPLES = 5; // need at least 5 days of baseline data

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
  let idx = rows.length - 1;
  // 1. Never treat the open current UTC day (or any future-dated row) as closed.
  if (todayUtc) {
    while (idx >= 0 && rows[idx].date >= todayUtc) idx -= 1;
  }
  // 2. PV-completeness guard: a candidate whose PV is < 50% of the prior
  //    day's PV is probably still being collected — step back one.
  if (idx >= 1) {
    const prior = rows[idx - 1].pageViews;
    const cand = rows[idx].pageViews;
    if (prior > 0 && cand < prior * 0.5) idx -= 1;
  }
  return idx;
}

/**
 * Classify the daily RPM rows into healthy / regression / insufficient-data.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {{ ratioFloor?: number, absoluteFloor?: number, earningsFloor?: number, todayUtc?: string }} [opts]
 */
export function classifyRpm(rows, opts = {}) {
  const ratioFloor = opts.ratioFloor ?? DEFAULT_RATIO_FLOOR;
  const absoluteFloor = opts.absoluteFloor ?? DEFAULT_ABSOLUTE_FLOOR;
  const earningsFloor = opts.earningsFloor ?? DEFAULT_EARNINGS_FLOOR;
  const todayUtc = opts.todayUtc;

  if (rows.length < BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: "insufficient-data",
      reason: `need ≥${BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES} days of data, got ${rows.length}`,
    };
  }

  const latestClosedIdx = latestClosedIndex(rows, todayUtc);
  if (latestClosedIdx < 0) {
    return { verdict: "insufficient-data", reason: "no fully-closed day available" };
  }

  const currentRow = rows[latestClosedIdx];
  const baselineEnd = latestClosedIdx - (BASELINE_LAG_DAYS - 1);
  const baselineStart = baselineEnd - BASELINE_DAYS;
  if (baselineStart < 0 || baselineEnd <= baselineStart) {
    return { verdict: "insufficient-data", reason: "baseline window underflowed" };
  }
  const baselineRows = rows.slice(baselineStart, baselineEnd);
  if (baselineRows.length < REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: "insufficient-data",
      reason: `baseline window has ${baselineRows.length} samples, need ${REQUIRED_BASELINE_SAMPLES}`,
    };
  }

  const baselineRpm =
    baselineRows.reduce((s, r) => s + (r.rpm || 0), 0) / baselineRows.length;
  const baselineEarnings =
    baselineRows.reduce((s, r) => s + (r.earnings || 0), 0) / baselineRows.length;
  const ratio = baselineRpm > 0 ? currentRow.rpm / baselineRpm : 1;
  const earningsRatio =
    baselineEarnings > 0 ? currentRow.earnings / baselineEarnings : 1;

  // RPM signal — sensitive trigger (a ratio drop or an absolute-floor breach).
  const rpmReasons = [];
  if (currentRow.rpm < absoluteFloor) {
    rpmReasons.push(`RPM ${currentRow.rpm.toFixed(2)} < absolute floor ${absoluteFloor.toFixed(2)}`);
  }
  if (baselineRpm > 0 && ratio < ratioFloor) {
    rpmReasons.push(
      `RPM ${currentRow.rpm.toFixed(2)} = ${(ratio * 100).toFixed(0)}% of baseline ${baselineRpm.toFixed(2)} (floor ${(ratioFloor * 100).toFixed(0)}%)`,
    );
  }
  const rpmLow = rpmReasons.length > 0;

  // Earnings confirmation — a real revenue incident depresses absolute
  // earnings; a page-view spike with healthy earnings does not. Treat a
  // zero/absent baseline as "can't confirm" → fall back to the RPM signal
  // (better a rare false alarm than a missed real incident with no baseline).
  const earningsLow =
    baselineEarnings > 0 ? earningsRatio < earningsFloor : true;

  const isRegression = rpmLow && earningsLow;

  const reasons = [];
  let note;
  if (isRegression) {
    reasons.push(...rpmReasons);
    reasons.push(
      `Earnings ${currentRow.earnings.toFixed(2)} = ${(earningsRatio * 100).toFixed(0)}% of baseline ${baselineEarnings.toFixed(2)} (floor ${(earningsFloor * 100).toFixed(0)}%)`,
    );
  } else if (rpmLow && !earningsLow) {
    // Benign: RPM dipped but earnings held — almost always a page-view spike.
    note =
      `RPM dip is benign: earnings ${currentRow.earnings.toFixed(2)} = ${(earningsRatio * 100).toFixed(0)}% of baseline ${baselineEarnings.toFixed(2)} (≥ ${(earningsFloor * 100).toFixed(0)}% floor) — the low RPM is a page-view spike (pv=${currentRow.pageViews}), not lost revenue.`;
  }

  return {
    verdict: isRegression ? "regression" : "healthy",
    current: {
      date: currentRow.date,
      rpm: currentRow.rpm,
      earnings: currentRow.earnings,
      pageViews: currentRow.pageViews,
    },
    baseline: {
      from: baselineRows[0].date,
      to: baselineRows[baselineRows.length - 1].date,
      rpm: Number(baselineRpm.toFixed(3)),
      earnings: Number(baselineEarnings.toFixed(2)),
      samples: baselineRows.length,
    },
    ratio: Number((ratio || 0).toFixed(3)),
    earningsRatio: Number((earningsRatio || 0).toFixed(3)),
    floors: { ratio: ratioFloor, absoluteCHF: absoluteFloor, earnings: earningsFloor },
    reasons,
    ...(note ? { note } : {}),
  };
}
