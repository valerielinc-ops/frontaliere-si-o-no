/**
 * mixAdjustedRateGate.mjs
 *
 * Shared "expected total rate" computation for per-feature rate-ratchet
 * audits (audit-text-html-ratio.mjs, audit-title-length.mjs).
 *
 * Problem this fixes: a naive TOTAL aggregate check compares the current
 * blended offender rate against a flat historical blended baseline rate.
 * That's composition-shift-blind — if an accepted-thin feature (e.g. an
 * inherently markup-heavy template category) legitimately grows its SHARE
 * of total scanned pages, the blended total mechanically drifts upward even
 * though every feature's OWN rate held steady or improved and
 * `regressedFeatures` is empty. This recurred identically across two
 * incidents (#3232 on text-html-ratio, band-aided via rebaseline; the same
 * class would hit any per-feature-rate audit's total check).
 *
 * Fix: weight CURRENT per-feature scanned counts against BASELINE
 * per-feature rates to get an "expected" total — a composition-shift-neutral
 * blend. Only a genuine per-feature rate INCREASE above its own baseline
 * moves the expected total; pure mix shift among features whose own rate
 * held or improved does not.
 */

/**
 * @param {object} args
 * @param {Record<string, number>} args.scannedByFeature current per-feature scanned counts
 * @param {Record<string, {ratePct?: number, scanned?: number}>} args.baseByFeature baseline per-feature rate snapshot
 * @param {{relPct: number, absPp: number, maxDeltaPp: number}} args.tol
 * @returns {{ expectedOffenders: number, expectedTotalRate: number, totalCap: number, missingFeatures: string[] }}
 */
export function computeMixAdjustedTotalCap({ scannedByFeature, baseByFeature, tol }) {
  let expectedOffenders = 0;
  let totalScanned = 0;
  for (const [feature, scanned] of Object.entries(scannedByFeature)) {
    totalScanned += scanned;
    // Feature absent from the baseline (brand-new category) has no
    // historical rate to anchor to — treat it as 0 here. A brand-new
    // feature with a real offender rate already fails independently via
    // the per-feature regression loop (baseOff=0, baseRate=0), so this
    // fallback doesn't let a new thin template slip through unnoticed —
    // it just doesn't double-count it in the mix-adjustment.
    const baseRate = Number(baseByFeature?.[feature]?.ratePct ?? 0);
    expectedOffenders += (scanned * baseRate) / 100;
  }
  // Inverse case (#3607): a baseline feature bucket that is entirely ABSENT
  // from the current scan (e.g. a partial BFS walk that never reached that
  // template category) contributes nothing to totalScanned/expectedOffenders
  // above — silently narrowing the total check's scope down to whatever the
  // (possibly incomplete) scan happened to cover, instead of flagging that
  // the scan itself is incomplete. That's a false-green: an incomplete scan
  // reads as a legitimately smaller expected total. Only baseline features
  // that actually had scanned pages recorded are flagged — a feature the
  // baseline legitimately retired (recorded with scanned:0) isn't a scan
  // regression.
  const missingFeatures = Object.keys(baseByFeature ?? {}).filter((feature) => {
    if (Object.prototype.hasOwnProperty.call(scannedByFeature, feature)) return false;
    return Number(baseByFeature[feature]?.scanned ?? 0) > 0;
  });
  const expectedTotalRate = totalScanned ? (expectedOffenders / totalScanned) * 100 : 0;
  const totalCap =
    expectedTotalRate + Math.min((expectedTotalRate * tol.relPct) / 100, tol.maxDeltaPp) + tol.absPp;
  return { expectedOffenders, expectedTotalRate, totalCap, missingFeatures };
}

/**
 * @param {object} args
 * @param {Record<string, number>} args.scannedByFeature
 * @param {Record<string, {ratePct?: number}>} args.baseByFeature
 * @param {{relPct: number, absPp: number, maxDeltaPp: number, minAbsDelta: number}} args.tol
 * @param {number} args.actualOffenders
 * @param {number} args.actualScanned
 */
export function evaluateMixAdjustedTotalRegression({
  scannedByFeature,
  baseByFeature,
  tol,
  actualOffenders,
  actualScanned,
}) {
  const { expectedOffenders, expectedTotalRate, totalCap, missingFeatures } = computeMixAdjustedTotalCap({
    scannedByFeature,
    baseByFeature,
    tol,
  });
  const actualTotalRate = actualScanned ? (actualOffenders / actualScanned) * 100 : 0;
  // Same AND-condition shape as the per-feature ratchet: a rate-only spike
  // (e.g. from a shrinking denominator) with no meaningful absolute growth
  // must not fail the gate on its own (class #1604 — see
  // audit-text-html-ratio.mjs's per-feature comment for the incident).
  const rateRegression = actualTotalRate > totalCap && actualOffenders > expectedOffenders + tol.minAbsDelta;
  // A baseline feature bucket entirely missing from the current scan means
  // the scan is INCOMPLETE, not that the site legitimately improved (#3607).
  // Fail the gate unconditionally on this — it must not be masked by the
  // AND-condition floor above, since an incomplete scan can under-report
  // `actualOffenders`/`actualScanned` too, hiding real regressions in the
  // untouched feature.
  const regression = rateRegression || missingFeatures.length > 0;
  return { expectedOffenders, expectedTotalRate, totalCap, actualTotalRate, regression, missingFeatures };
}
