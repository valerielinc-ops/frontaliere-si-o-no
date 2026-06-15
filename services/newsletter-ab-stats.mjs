/**
 * newsletter-ab-stats.mjs — pure statistics for the subject-line A/B test.
 *
 * No I/O, no Firestore, no dependencies → safe to import anywhere (the send
 * script, the report, the Cloud Functions, tests). Shared single source of
 * truth for the significance test + winner selection so the report's readout
 * and the send pipeline's auto-promotion can never drift apart.
 */

/** Standard normal CDF (Abramowitz–Stegun erf approximation). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Two-proportion z-test (two-sided).
 * @param {{sends:number,opens:number}} a
 * @param {{sends:number,opens:number}} b
 * @returns {{z:number,pValue:number}|null} null if either sample is empty.
 */
export function twoProportionTest(a, b) {
  if (!a?.sends || !b?.sends) return null;
  const p1 = a.opens / a.sends;
  const p2 = b.opens / b.sends;
  const pPool = (a.opens + b.opens) / (a.sends + b.sends);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.sends + 1 / b.sends));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue };
}

export const openRate = (cell) => (cell && cell.sends > 0 ? cell.opens / cell.sends : 0);

/** Default gates for declaring an auto-promotable winner. Conservative on
 * purpose: never promote on thin data or a noisy difference. */
export const DEFAULT_WINNER_GATES = Object.freeze({
  minSendsPerArm: 200, // each variant must have at least this many sends
  alpha: 0.05,         // two-sided significance threshold
});

/**
 * Decide the winning variant from pooled per-variant totals.
 *
 * Only returns a winner when EVERY arm has ≥ minSendsPerArm sends AND the best
 * vs the runner-up is significant at `alpha`. Otherwise winner is null (caller
 * should fall back to an even split). Currently expects exactly two arms; with
 * other counts it returns the best by open rate only if significant vs the
 * runner-up (and all arms meet the sample gate).
 *
 * @param {Record<string,{sends:number,opens:number}>} byVariant
 * @param {{minSendsPerArm?:number, alpha?:number}} [gates]
 * @returns {{winner:string|null, openRates:Record<string,number>, pValue:number|null, reason:string}}
 */
export function pickWinner(byVariant, gates = {}) {
  const { minSendsPerArm, alpha } = { ...DEFAULT_WINNER_GATES, ...gates };
  const ids = Object.keys(byVariant || {});
  const openRates = {};
  for (const id of ids) openRates[id] = openRate(byVariant[id]);

  if (ids.length < 2) return { winner: null, openRates, pValue: null, reason: 'need ≥2 arms' };
  if (ids.some((id) => (byVariant[id]?.sends || 0) < minSendsPerArm)) {
    return { winner: null, openRates, pValue: null, reason: 'insufficient sample' };
  }

  const ranked = [...ids].sort((a, b) => openRates[b] - openRates[a]);
  const best = ranked[0];
  const runnerUp = ranked[1];
  const test = twoProportionTest(byVariant[best], byVariant[runnerUp]);
  if (!test || test.pValue >= alpha) {
    return { winner: null, openRates, pValue: test?.pValue ?? null, reason: 'not significant' };
  }
  return { winner: best, openRates, pValue: test.pValue, reason: 'significant' };
}
