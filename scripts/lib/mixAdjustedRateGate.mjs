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

// Sampling-aware corrections (2026-07-23). AUDIT_SAMPLE_RATE (see
// scripts/lib/audit-runner.mjs's sampleFiles()) deliberately reads only a
// rotating fraction of dist/ per run. Two consumers of this file's output
// were built assuming an always-complete scan and broke once that stopped
// being true (caught in PR #4695's review, round 1 and 2 — NOT actually
// fixed before merge; this commit is the real fix):
//
// 1. `curOff > baseOff + tol.minAbsDelta` (each gate's own per-feature loop,
//    duplicated across audit-text-html-ratio.mjs/audit-title-length.mjs/
//    audit-h1-title-duplicates.mjs/audit-title-no-disambig-hash.mjs) compares
//    a SAMPLED current count against an UNSAMPLED baseline count — a genuine
//    regression needs to be ~1/rate times larger before the floor fires.
//    Fix: extrapolateSampledCount() below, called at each of the 4 sites
//    instead of comparing curOff directly.
//
// 2. The #3607 "incomplete scan" hard-fail (missingFeatures.length > 0 below)
//    assumed ANY baseline feature missing from the current scan means a
//    BROKEN walk (unknown, unbounded gap) — correct for that threat model,
//    but sampling deliberately produces bounded, small-feature all-zero
//    draws by design (e.g. an 8-page baseline bucket has a ~10% chance of
//    landing zero pages in a 25% sample on any given run — see
//    isPlausibleSamplingMiss()). Treating every one of those as a hard
//    regression turns a known, bounded sampling artifact into a ~10%-per-run
//    false CI failure on that bucket. Fix: a missing feature only counts as
//    a genuine regression signal if its baseline scanned-count is large
//    enough that an all-zero draw is IMPLAUSIBLE by chance at the current
//    sample rate — large buckets going missing (still overwhelmingly likely
//    to mean "broken walk") are unaffected.
// 3. (Caught in THIS fix's own PR review, round 2 — not a pre-existing bug,
//    introduced by items 1/2 above): evaluateMixAdjustedTotalRegression()'s
//    total-level check initially applied the SAME extrapolateSampledCount()
//    fix to `actualOffenders` before comparing it to `expectedOffenders` —
//    but `expectedOffenders` (computeMixAdjustedTotalCap(), below) is
//    computed as `scanned(current, possibly sampled) * baseRate`, i.e. it's
//    ALREADY on the same sampled scale as `actualOffenders` (both derived
//    from this run's own scannedByFeature), unlike the per-feature loop's
//    `baseOff` (a stored, always-full-corpus count). Extrapolating only one
//    side of an already-matched-scale comparison inflated actualOffenders
//    ~4× at rate=0.25 while expectedOffenders stayed put, defeating
//    tol.minAbsDelta at any sampleRate < 1 — see evaluateMixAdjustedTotalRegression's
//    own inline comment for the fix.
const SAMPLING_FALSE_POSITIVE_TOLERANCE = 0.01; // 1% — matches typical CI flake budget

/**
 * @param {number} count a count drawn from a SAMPLED scan
 * @param {number} sampleRate 0 < rate <= 1; 1 (or omitted) = no sampling, returns count unchanged
 * @returns {number} count extrapolated to full-corpus-equivalent scale
 */
export function extrapolateSampledCount(count, sampleRate) {
  return sampleRate > 0 && sampleRate < 1 ? count / sampleRate : count;
}

/**
 * @param {number} baselineScanned the baseline's recorded scanned count for this feature
 * @param {number} sampleRate 0 < rate <= 1; 1 (or omitted) = no sampling active
 * @returns {boolean} true if drawing zero pages from this feature by pure sampling
 *   chance is plausible (not negligible) at the current rate — i.e. this feature
 *   should NOT be treated as evidence of an incomplete/broken scan.
 */
export function isPlausibleSamplingMiss(baselineScanned, sampleRate) {
  if (!(sampleRate > 0) || sampleRate >= 1) return false;
  return Math.pow(1 - sampleRate, baselineScanned) > SAMPLING_FALSE_POSITIVE_TOLERANCE;
}

/**
 * @param {object} args
 * @param {Record<string, number>} args.scannedByFeature current per-feature scanned counts
 * @param {Record<string, {ratePct?: number, scanned?: number}>} args.baseByFeature baseline per-feature rate snapshot
 * @param {{relPct: number, absPp: number, maxDeltaPp: number}} args.tol
 * @param {number} [args.sampleRate] 0 < rate <= 1; omit/1 = no sampling active
 * @returns {{ expectedOffenders: number, expectedTotalRate: number, totalCap: number, missingFeatures: string[] }}
 */
export function computeMixAdjustedTotalCap({ scannedByFeature, baseByFeature, tol, sampleRate = 1 }) {
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
    const baselineScanned = Number(baseByFeature[feature]?.scanned ?? 0);
    if (baselineScanned <= 0) return false;
    // Sampling can legitimately draw zero pages from a small feature bucket
    // (see module header) — that's not evidence of an incomplete/broken scan.
    if (isPlausibleSamplingMiss(baselineScanned, sampleRate)) return false;
    return true;
  });
  const expectedTotalRate = totalScanned ? (expectedOffenders / totalScanned) * 100 : 0;
  const totalCap =
    expectedTotalRate + Math.min((expectedTotalRate * tol.relPct) / 100, tol.maxDeltaPp) + tol.absPp;
  return { expectedOffenders, expectedTotalRate, totalCap, missingFeatures };
}

/**
 * @param {object} args
 * @param {Record<string, number>} args.scannedByFeature
 * @param {Record<string, {ratePct?: number, scanned?: number}>} args.baseByFeature
 * @param {{relPct: number, absPp: number, maxDeltaPp: number, minAbsDelta: number}} args.tol
 * @param {number} args.actualOffenders
 * @param {number} args.actualScanned
 * @param {number} [args.sampleRate] 0 < rate <= 1; omit/1 = no sampling active
 */
export function evaluateMixAdjustedTotalRegression({
  scannedByFeature,
  baseByFeature,
  tol,
  actualOffenders,
  actualScanned,
  sampleRate = 1,
}) {
  const { expectedOffenders, expectedTotalRate, totalCap, missingFeatures } = computeMixAdjustedTotalCap({
    scannedByFeature,
    baseByFeature,
    tol,
    sampleRate,
  });
  const actualTotalRate = actualScanned ? (actualOffenders / actualScanned) * 100 : 0;
  // Same AND-condition shape as the per-feature ratchet: a rate-only spike
  // (e.g. from a shrinking denominator) with no meaningful absolute growth
  // must not fail the gate on its own (class #1604 — see
  // audit-text-html-ratio.mjs's per-feature comment for the incident).
  //
  // NO extrapolation here (unlike the per-feature loop's `curOff` compare
  // against a baseline `baseOff`) — caught in PR #4717's own review: unlike
  // `baseOff` (a stored, always-full-corpus count from the baseline JSON),
  // `expectedOffenders` is computed by computeMixAdjustedTotalCap() as
  // `scanned(current, possibly sampled) * baseRate` — i.e. it's already on
  // the SAME (sampled) scale as `actualOffenders`, both derived from this
  // run's own scannedByFeature. Extrapolating only `actualOffenders` here
  // (an earlier version of this fix did) compares a sampled count against
  // an inflated one, defeating the tol.minAbsDelta noise floor at any
  // sampleRate < 1 — the exact false-fail class this function exists to
  // prevent, reintroduced by the sampling fix itself.
  const rateRegression = actualTotalRate > totalCap
    && actualOffenders > expectedOffenders + tol.minAbsDelta;
  // A baseline feature bucket entirely missing from the current scan means
  // the scan is INCOMPLETE, not that the site legitimately improved (#3607).
  // Fail the gate unconditionally on this — it must not be masked by the
  // AND-condition floor above, since an incomplete scan can under-report
  // `actualOffenders`/`actualScanned` too, hiding real regressions in the
  // untouched feature.
  const regression = rateRegression || missingFeatures.length > 0;
  return { expectedOffenders, expectedTotalRate, totalCap, actualTotalRate, regression, missingFeatures };
}
