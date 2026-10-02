/**
 * When saving a listing turns the weekly saved-jobs digest on.
 *
 * Owner decision of 2026-10-02: the digest is activated by saving a listing,
 * with no backfill of accounts that saved before this change. The state lives
 * on `users/{uid}.savedJobsDigest` and has three values, not two:
 *
 *   - `optedOut === true`  → turned off by the person: the one-click link in
 *     the digest (functions/src/savedJobsDigestUnsubscribe.js), the switch in
 *     /profilo/ or "stop all" there. Final for this path: a later save never
 *     turns it back on. Only the person can, from /profilo/.
 *   - `optedIn === true`   → on (a save, or the switch in /profilo/).
 *   - anything else        → never decided: no field, or the
 *     `{ optedIn: false, optedOut: false }` default older profiles carry.
 *
 * Relative imports only (none at all): the browser bundle
 * (services/savedJobsService.ts) and plain-Node tests read the same rule.
 */

/** Provenance stamped next to `optedIn` when a save is what activated it. */
export const SAVED_JOBS_DIGEST_SAVE_ACTIVATION = 'saved_job';

/**
 * @param {unknown} digest the `savedJobsDigest` map of `users/{uid}`, or null
 * @returns {'on' | 'off' | 'undecided'}
 */
export function savedJobsDigestChoice(digest) {
  if (!digest || typeof digest !== 'object') return 'undecided';
  if (digest.optedOut === true) return 'off';
  if (digest.optedIn === true) return 'on';
  return 'undecided';
}

/**
 * Whether a save may write the activation. Only a never-decided digest is
 * activated; an explicit stop always wins and an active digest needs no write.
 *
 * @param {unknown} digest
 * @returns {boolean}
 */
export function shouldActivateSavedJobsDigestOnSave(digest) {
  return savedJobsDigestChoice(digest) === 'undecided';
}
