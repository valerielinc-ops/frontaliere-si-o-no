/**
 * canaryRegressionClassify.mjs — generic dual-signal regression classifier
 * shared by scripts/lib/canaryRpmClassify.mjs (AdSense RPM canary) and
 * scripts/lib/arpuCanaryClassify.mjs (user-value ARPU canary).
 *
 * Both canaries watch a RATIO metric (earnings÷pageViews for RPM,
 * revenue÷activeUsers for ARPU) against a trailing baseline, but a ratio
 * alone false-alarms on denominator-only swings (a traffic spike halves the
 * ratio without losing a cent — see canaryRpmClassify.mjs's docstring for
 * the incident, #2176, that this two-signal design was born from). A
 * regression is only declared when the ratio drops AND a confirming
 * absolute metric (earnings/revenue) also drops — that second signal is
 * what tells a real incident (both collapse) apart from benign volume
 * noise (only the ratio moves).
 *
 * Kept metric-agnostic (`value`/`confirm`/`volume` fields, caller-supplied
 * text labels) so a second canary doesn't have to re-derive this same
 * baseline-window + two-signal-gate logic from scratch.
 */

export const DEFAULT_RATIO_FLOOR = 0.65;
export const DEFAULT_ABSOLUTE_FLOOR = 0; // 0 = disabled; opt in once a metric has a calibrated floor
export const DEFAULT_CONFIRM_FLOOR = 0.65;
export const BASELINE_DAYS = 7;
export const BASELINE_LAG_DAYS = 3; // baseline ends at T-3 (skips noisy last days)
export const REQUIRED_BASELINE_SAMPLES = 5; // need at least 5 days of baseline data

const DEFAULT_LABELS = {
  metric: 'value',
  confirm: 'confirm',
  volumeNoun: 'volume',
  volumeAbbrev: 'vol',
  decimals: 2,
};

/**
 * @typedef {{ date: string, value: number, confirm: number, volume: number }} DailyRow
 */

/**
 * Pick the latest fully-closed day. The current UTC day (`todayUtc`) is
 * never closed — drop it and anything after it. Then, defensively, if the
 * resulting candidate's volume looks truncated (< 50% of the day before),
 * step back one more in case the source hasn't settled yesterday yet.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {string|undefined} todayUtc YYYY-MM-DD of the current UTC day
 * @returns {number} index of the latest closed row (may be -1 if none)
 */
export function latestClosedIndex(rows, todayUtc) {
  let idx = rows.length - 1;
  if (todayUtc) {
    while (idx >= 0 && rows[idx].date >= todayUtc) idx -= 1;
  }
  if (idx >= 1) {
    const prior = rows[idx - 1].volume;
    const cand = rows[idx].volume;
    if (prior > 0 && cand < prior * 0.5) idx -= 1;
  }
  return idx;
}

/**
 * Classify daily rows into healthy / regression / insufficient-data.
 *
 * @param {DailyRow[]} rows ascending by date
 * @param {{ ratioFloor?: number, absoluteFloor?: number, confirmFloor?: number, todayUtc?: string,
 *            labels?: { metric?: string, confirm?: string, volumeNoun?: string, volumeAbbrev?: string, decimals?: number } }} [opts]
 */
export function classifyRegression(rows, opts = {}) {
  const ratioFloor = opts.ratioFloor ?? DEFAULT_RATIO_FLOOR;
  const absoluteFloor = opts.absoluteFloor ?? DEFAULT_ABSOLUTE_FLOOR;
  const confirmFloor = opts.confirmFloor ?? DEFAULT_CONFIRM_FLOOR;
  const todayUtc = opts.todayUtc;
  const labels = { ...DEFAULT_LABELS, ...(opts.labels || {}) };
  const d = labels.decimals;
  const fmt = (n) => n.toFixed(d);
  const pct = (n) => (n * 100).toFixed(0);

  if (rows.length < BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: 'insufficient-data',
      reason: `need ≥${BASELINE_LAG_DAYS + REQUIRED_BASELINE_SAMPLES} days of data, got ${rows.length}`,
    };
  }

  const latestClosedIdx = latestClosedIndex(rows, todayUtc);
  if (latestClosedIdx < 0) {
    return { verdict: 'insufficient-data', reason: 'no fully-closed day available' };
  }

  const currentRow = rows[latestClosedIdx];
  const baselineEnd = latestClosedIdx - (BASELINE_LAG_DAYS - 1);
  const baselineStart = baselineEnd - BASELINE_DAYS;
  if (baselineStart < 0 || baselineEnd <= baselineStart) {
    return { verdict: 'insufficient-data', reason: 'baseline window underflowed' };
  }
  const baselineRows = rows.slice(baselineStart, baselineEnd);
  if (baselineRows.length < REQUIRED_BASELINE_SAMPLES) {
    return {
      verdict: 'insufficient-data',
      reason: `baseline window has ${baselineRows.length} samples, need ${REQUIRED_BASELINE_SAMPLES}`,
    };
  }

  const baselineValue = baselineRows.reduce((s, r) => s + (r.value || 0), 0) / baselineRows.length;
  const baselineConfirm = baselineRows.reduce((s, r) => s + (r.confirm || 0), 0) / baselineRows.length;
  const ratio = baselineValue > 0 ? currentRow.value / baselineValue : 1;
  const confirmRatio = baselineConfirm > 0 ? currentRow.confirm / baselineConfirm : 1;

  // Ratio signal — sensitive trigger (a ratio drop or an absolute-floor breach).
  const valueReasons = [];
  if (absoluteFloor > 0 && currentRow.value < absoluteFloor) {
    valueReasons.push(`${labels.metric} ${fmt(currentRow.value)} < absolute floor ${fmt(absoluteFloor)}`);
  }
  if (baselineValue > 0 && ratio < ratioFloor) {
    valueReasons.push(
      `${labels.metric} ${fmt(currentRow.value)} = ${pct(ratio)}% of baseline ${fmt(baselineValue)} (floor ${pct(ratioFloor)}%)`,
    );
  }
  const valueLow = valueReasons.length > 0;

  // Confirming signal — a real incident depresses the absolute confirming
  // metric; a volume spike with a healthy confirming metric does not. Treat
  // a zero/absent baseline as "can't confirm" → fall back to the ratio
  // signal (better a rare false alarm than a missed real incident).
  const confirmLow = baselineConfirm > 0 ? confirmRatio < confirmFloor : true;

  const isRegression = valueLow && confirmLow;

  const reasons = [];
  let note;
  if (isRegression) {
    reasons.push(...valueReasons);
    reasons.push(
      `${labels.confirm} ${fmt(currentRow.confirm)} = ${pct(confirmRatio)}% of baseline ${fmt(baselineConfirm)} (floor ${pct(confirmFloor)}%)`,
    );
  } else if (valueLow && !confirmLow) {
    // Benign: the ratio dipped but the confirming metric held — almost always a volume spike.
    note =
      `${labels.metric} dip is benign: ${labels.confirm.toLowerCase()} ${fmt(currentRow.confirm)} = ${pct(confirmRatio)}% of baseline ${fmt(baselineConfirm)} (≥ ${pct(confirmFloor)}% floor) — the low ${labels.metric} is a ${labels.volumeNoun} spike (${labels.volumeAbbrev}=${currentRow.volume}), not lost revenue.`;
  }

  return {
    verdict: isRegression ? 'regression' : 'healthy',
    current: {
      date: currentRow.date,
      value: currentRow.value,
      confirm: currentRow.confirm,
      volume: currentRow.volume,
    },
    baseline: {
      from: baselineRows[0].date,
      to: baselineRows[baselineRows.length - 1].date,
      value: Number(baselineValue.toFixed(3)),
      confirm: Number(baselineConfirm.toFixed(3)),
      samples: baselineRows.length,
    },
    ratio: Number((ratio || 0).toFixed(3)),
    confirmRatio: Number((confirmRatio || 0).toFixed(3)),
    floors: { ratio: ratioFloor, absolute: absoluteFloor, confirm: confirmFloor },
    reasons,
    ...(note ? { note } : {}),
  };
}
