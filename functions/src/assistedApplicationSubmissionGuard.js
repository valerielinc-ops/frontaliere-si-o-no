/**
 * Durable idempotency of the application's submission, per order and round
 * (`{order}/automation/submission`, field `r<round>`). The watchdog of the
 * flow re-dispatches a submit run that went silent; if the first run's send
 * went through and the run died before reporting, the retry must not send a
 * second application:
 *
 *   claim → 'claimed'       nothing sent yet for this round: go ahead
 *         → 'already_sent'  the retry returns the outcome on record
 *         → 'in_flight'     a previous run started a send whose outcome is
 *                           unknown: never re-sent (career-ops), the owner
 *                           takes over
 *   markSent  the send went through (before the evidence and the event)
 *   release   the send failed for certain: a later run may try again
 */

import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

export const SUBMISSION_DOC_ID = 'submission';

export function submissionRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(SUBMISSION_DOC_ID);
}

export function submissionGuard(db, orderId, round) {
  const ref = submissionRefFor(db, orderId);
  const key = `r${Number(round) || 1}`;
  return {
    /**
     * @param {{resumable?: boolean}} [options] a portal submission: a run that
     *   died BEFORE pressing submit (no clickedAt) left nothing at the
     *   employer, so it may start again; after the click it stays ambiguous
     */
    async claim(channel, nowMs = Date.now(), { resumable = false } = {}) {
      let outcome = null;
      await db.runTransaction(async (transaction) => {
        const current = (await transaction.get(ref)).data()?.[key];
        if (current?.state === 'sent') {
          outcome = { status: 'already_sent', record: current };
          return;
        }
        if (current?.state === 'sending' && !(resumable && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        transaction.set(ref, { [key]: { state: 'sending', channel, startedAt: nowMs, clickedAt: null } }, { merge: true });
        outcome = { status: 'claimed', resumed: current?.state === 'sending' };
      });
      return outcome;
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now()) {
      await ref.set({ [key]: { clickedAt: nowMs } }, { merge: true });
    },
    async markSent(record = {}, nowMs = Date.now()) {
      await ref.set({ [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
    },
    async release(reason, nowMs = Date.now()) {
      await ref.set({ [key]: { state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs } }, { merge: true });
    },
  };
}
