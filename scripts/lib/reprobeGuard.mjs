/**
 * Shared exit-guard for machine-inferred `inactive` sunset states (issue #5559).
 *
 * Both scripts/lib/subscriberSunset.mjs and scripts/lib/jobAlertSunset.mjs put a
 * subscriber into `inactive` on zero engagement, then only ever leave it on
 * FRESH engagement — evidence that can't be produced because `inactive` is
 * exactly the state that stops sending to them. That makes the exit
 * unreachable by construction, not by a coding mistake.
 *
 * This guard is the one-time, capped escape valve: after long enough silence
 * with no prior attempt, the classifier is allowed to return a `reprobe`
 * verdict that puts the subscriber back on a mailable status for ONE more
 * send. If they engage, the normal reactivate/engaged path takes over. If
 * they don't, `attempts` reaches REPROBE_MAX_ATTEMPTS and this guard refuses
 * forever — no ping-pong (review PR #4338, bug C caused the earlier version
 * of this file to guard against ping-pong by removing the exit entirely).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const REPROBE_AFTER_INACTIVE_DAYS = 90;
export const REPROBE_MAX_ATTEMPTS = 1;

/**
 * @param {object} p
 * @param {number} p.attempts prior reprobe attempts already made
 *   (sunset_reprobe_count — deliberately namespaced apart from
 *   suppressionDecay.mjs's own unrelated `reprobe_count` field, which lives
 *   on the same two collections for a different bounced/suppressed → active
 *   recovery mechanism with its own independent cap; sharing the bare name
 *   would let one mechanism's counter silently exhaust the other's budget)
 * @param {number|null} p.anchorMs ms to measure silence from — sunset_reprobed_at
 *   if a prior attempt exists, else inactive_at
 * @param {number} p.nowMs
 * @returns {boolean} true when a fresh reprobe attempt is due now
 */
export function isReprobeDue({ attempts, anchorMs, nowMs }) {
  if (attempts >= REPROBE_MAX_ATTEMPTS) return false;
  if (anchorMs == null) return false;
  return (nowMs - anchorMs) / DAY_MS >= REPROBE_AFTER_INACTIVE_DAYS;
}
