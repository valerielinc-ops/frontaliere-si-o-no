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
 *   markSent  the send went through (before the evidence and the event), or
 *             the employer's e-mail later proved that an unconfirmed one did
 *             (`confirmedBy: 'acknowledgement'`)
 *   release   the send failed for certain: a later run may try again
 */

import { randomUUID } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

export const SUBMISSION_DOC_ID = 'submission';

export function submissionRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(SUBMISSION_DOC_ID);
}

/**
 * The submission may have reached the employer, and nothing confirmed it: a
 * portal after its final click, or an e-mail whose send started (it is left
 * "sending" only when its outcome is unknown). Before the click nothing left.
 */
export function isUnconfirmedSubmission(record) {
  return record?.state === 'sending' && (Boolean(record.clickedAt) || record.channel === 'email');
}

/** When an unconfirmed submission left: the final click, or the start of the e-mail send. */
export function submissionLeftAt(record) {
  return Number(record?.clickedAt || record?.startedAt) || 0;
}

export function submissionGuard(db, orderId, round, { answerSourceGuard = null } = {}) {
  const ref = submissionRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const key = `r${Number(round) || 1}`;
  let claimedAttemptId = null;
  const requireOwnClaim = (submission, channel) => {
    const current = submission?.[key];
    if (current?.state === 'sent') throw Object.assign(new Error('submission_already_sent'), { code: 'submission_already_sent', record: current });
    if (!claimedAttemptId || current?.state !== 'sending' || current.attemptId !== claimedAttemptId
      || !(Array.isArray(channel) ? channel : [channel]).includes(current.channel) || current.clickedAt) {
      throw Object.assign(new Error('submission_claim_changed'), { code: 'submission_claim_changed' });
    }
  };
  return {
    async read() {
      return (await ref.get()).data()?.[key] || null;
    },
    /**
     * @param {{resumable?: boolean}} [options] a portal submission: a run that
     *   died BEFORE pressing submit (no clickedAt) left nothing at the
     *   employer, so it may start again; after the click it stays ambiguous
     */
    async claim(channel, nowMs = Date.now(), { resumable = false } = {}) {
      let outcome = null;
      const attemptId = randomUUID();
      await db.runTransaction(async (transaction) => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        const submission = submissionDoc.data();
        if (submission?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          outcome = { status: 'withdrawn' };
          return;
        }
        const current = submission?.[key];
        if (current?.state === 'sent') {
          outcome = { status: 'already_sent', record: current };
          return;
        }
        if (current?.state === 'sending' && !(resumable && channel !== 'email' && current.channel !== 'email' && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        transaction.set(ref, { [key]: { state: 'sending', channel, attemptId, startedAt: nowMs, clickedAt: null } }, { merge: true });
        claimedAttemptId = attemptId;
        outcome = { status: 'claimed', resumed: current?.state === 'sending' };
      });
      return outcome;
    },
    /** No claim or repair may hide an application that already left. */
    async inspect() {
      return db.runTransaction(async transaction => {
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        const submission = submissionDoc.data();
        const current = submission?.[key];
        if (current?.state === 'sent') return { status: 'already_sent', record: current };
        if (isUnconfirmedSubmission(current)) return { status: 'in_flight', record: current };
        if (submission?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') return { status: 'withdrawn' };
        return { status: 'available' };
      });
    },
    /** Immediately before SMTP/provider handoff; this is not a portal click. */
    async markEmailSending(nowMs = Date.now(), { answerSourceGuard: currentAnswerSourceGuard = answerSourceGuard } = {}) {
      await db.runTransaction(async transaction => {
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), 'email');
        if (currentAnswerSourceGuard) await currentAnswerSourceGuard.assertInTransaction(transaction);
        const [orderDoc, flowDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') throw new Error('application_withdrawn');
        transaction.set(ref, { [key]: { startedAt: nowMs } }, { merge: true });
      });
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now(), { answerSourceGuard: currentAnswerSourceGuard = answerSourceGuard } = {}) {
      await db.runTransaction(async transaction => {
        // All proof dependencies are reread in the same transaction as the
        // irreversible-send marker, before any write or external send.
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), ['portal', 'owner_extension']);
        if (currentAnswerSourceGuard) await currentAnswerSourceGuard.assertInTransaction(transaction);
        const [orderDoc, flowDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        transaction.set(ref, { [key]: { clickedAt: nowMs } }, { merge: true });
      });
    },
    async markSent(record = {}, nowMs = Date.now()) {
      await ref.set({ [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
    },
    /** Cleanup is CAS-protected too: a newer claim/receipt keeps its dossier. */
    async clearReleasedAttempt() {
      return db.runTransaction(async transaction => {
        const [submissionDoc, draftDoc] = await Promise.all([transaction.get(ref), transaction.get(draftRef)]);
        const current = submissionDoc.data()?.[key];
        if (!claimedAttemptId || current?.state !== 'failed' || current.attemptId !== claimedAttemptId) return false;
        if (!draftDoc.data()) return true;
        transaction.set(draftRef, { sentAttempt: null }, { merge: true });
        return true;
      });
    },
    async release(reason, nowMs = Date.now()) {
      return db.runTransaction(async transaction => {
        const current = (await transaction.get(ref)).data()?.[key];
        if (!claimedAttemptId || current?.state !== 'sending' || current.attemptId !== claimedAttemptId) return false;
        transaction.set(ref, { [key]: { state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs } }, { merge: true });
        return true;
      });
    },
  };
}
