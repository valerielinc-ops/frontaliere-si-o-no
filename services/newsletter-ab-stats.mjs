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

/**
 * Minimum sends PER ARM below which a two-proportion p-value must not be
 * printed at all (#7342 item 3). The z-test stays the arbiter of "is this
 * difference real" — this is a VALIDITY floor, not a second significance
 * heuristic: on a handful of sends the normal approximation has no basis and
 * the number still invites a decision it cannot support.
 */
export const MIN_COMPARISON_SENDS = 30;

/**
 * Companion validity condition: with the POOLED rate, each arm must expect at
 * least this many opens and non-opens. A 40-vs-40 comparison where one side
 * has 1 open clears MIN_COMPARISON_SENDS and still has no usable sampling
 * distribution.
 */
export const MIN_EXPECTED_PER_CELL = 5;

/**
 * True when a two-proportion z-test on these two arms is worth reporting.
 * Single source of truth for both readouts (subject-line A/B report and
 * send-hour impact report) so their "too thin to test" line can never drift.
 * @param {{sends:number,opens:number}} a
 * @param {{sends:number,opens:number}} b
 * @returns {boolean}
 */
export function hasEnoughPowerForTest(a, b) {
  const nA = a?.sends ?? 0;
  const nB = b?.sends ?? 0;
  if (nA < MIN_COMPARISON_SENDS || nB < MIN_COMPARISON_SENDS) return false;
  const pPool = ((a.opens ?? 0) + (b.opens ?? 0)) / (nA + nB);
  return [nA, nB].every((n) => n * pPool >= MIN_EXPECTED_PER_CELL && n * (1 - pPool) >= MIN_EXPECTED_PER_CELL);
}

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

/**
 * Resolve a winning variant per provider plus a global fallback, from a
 * provider × variant cell map (`cells[provider][variant] = {sends,opens}`).
 *
 * Each provider gets its own significant winner (or null); `global` is the
 * winner across all providers pooled. The send pipeline promotes
 * `byProvider[p] ?? global` for the provider that actually sends — so a provider
 * with thin data still benefits from the global signal instead of going even.
 *
 * @param {Record<string,Record<string,{sends:number,opens:number}>>} cells
 * @param {{minSendsPerArm?:number, alpha?:number}} [gates]
 * @returns {{byProvider:Record<string,string|null>, global:string|null}}
 */
export function resolveWinnersByProvider(cells, gates = {}) {
  const byProvider = {};
  const globalByVariant = {};
  for (const [provider, variants] of Object.entries(cells || {})) {
    byProvider[provider] = pickWinner(variants, gates).winner;
    for (const [v, c] of Object.entries(variants)) {
      globalByVariant[v] ??= { sends: 0, opens: 0 };
      globalByVariant[v].sends += c.sends;
      globalByVariant[v].opens += c.opens;
    }
  }
  return { byProvider, global: pickWinner(globalByVariant, gates).winner };
}
