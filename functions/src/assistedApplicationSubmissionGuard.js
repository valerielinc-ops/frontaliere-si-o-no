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

import { submissionAttemptHash, submissionSlotHash, submissionDraftMaterialHash, submissionAttemptMaterialHash, submissionOwnerIntent } from './lib/submissionReceiptContract.js';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';
import { roundWasSent } from './assistedApplicationFlow.js';
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

/** The existing automatic approval policy, with the owner's manual takeover exception. */
export function submissionFlowAllowsSend(flow, round, channel) {
  if (Number(flow?.round) !== Number(round)) return false;
  return channel === 'owner_extension' ? flow.state === 'owner_takeover'
    : ['portal', 'email'].includes(channel) && flow.state === 'submitting' && roundWasSent(flow, round);
}

export function submissionGuard(db, orderId, round, { answerSourceGuard = null } = {}) {
  const ref = submissionRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const guardedRound = Number(round) || 1;
  const key = `r${guardedRound}`;
  let claimedAttemptId = null;
  const requireOwnClaim = (submission, channel) => {
    const current = submission?.[key];
    if (current?.state === 'sent') throw Object.assign(new Error('submission_already_sent'), { code: 'submission_already_sent', record: current });
    if (!claimedAttemptId || current?.state !== 'sending' || current.attemptId !== claimedAttemptId
      || !(Array.isArray(channel) ? channel : [channel]).includes(current.channel) || current.clickedAt) {
      throw Object.assign(new Error('submission_claim_changed'), { code: 'submission_claim_changed' });
    }
  };
  const armHandoff = async (transaction, submission, nowMs, currentAnswerSourceGuard, materialHashes) => {
    if (typeof currentAnswerSourceGuard?.assertInTransaction !== 'function') {
      throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    }
    const sourceFingerprint = currentAnswerSourceGuard.fingerprint;
    const current = submission[key];
    const attemptHash = submissionAttemptHash(claimedAttemptId);
    const proofRef = orderRef.collection('submission_receipts').doc(attemptHash);
    if ((await transaction.get(proofRef)).exists) {
      throw Object.assign(new Error('submission_claim_changed'), { code: 'submission_claim_changed' });
    }
    // The provider checks current source deadlines after its reads. Keep it
    // as the final await; no proof/document read may open another time gap.
    await currentAnswerSourceGuard.assertInTransaction(transaction);
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint || '') || currentAnswerSourceGuard.fingerprint !== sourceFingerprint) {
      throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    }
    return { ref: proofRef, frame: { attemptHash, round: guardedRound, channel: current.channel,
      claimArmedAt: current.startedAt, handoffAt: nowMs, sourceFingerprint, ...materialHashes } };
  };
  return {
    attemptBinding() { return claimedAttemptId ? { id: claimedAttemptId, round: guardedRound } : null; },
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
      const markerStartedAt = Date.now();
      await db.runTransaction(async transaction => {
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), 'email');
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') throw new Error('application_withdrawn');
        if (!assistedApplicationRetained(orderDoc.data(), nowMs)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        if (!submissionFlowAllowsSend(flowDoc.data(), guardedRound, 'email')) throw Object.assign(new Error('submission_approval_changed'), { code: 'submission_approval_changed' });
        const proof = await armHandoff(transaction, submissionDoc.data(), nowMs, currentAnswerSourceGuard, { slotHash: submissionSlotHash({ orderId, order: orderDoc.data() }),
          draftMaterialHash: submissionDraftMaterialHash(draftDoc.data()), attemptMaterialHash: submissionAttemptMaterialHash(draftDoc.data()) });
        const handoffAt = nowMs + Math.max(0, Date.now() - markerStartedAt);
        if (!assistedApplicationRetained(orderDoc.data(), handoffAt)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        transaction.set(proof.ref, { ...proof.frame, handoffAt });
        transaction.set(ref, { [key]: { startedAt: handoffAt } }, { merge: true });
      });
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now(), { answerSourceGuard: currentAnswerSourceGuard = answerSourceGuard, ownerIntent = null } = {}) {
      let intentSnapshot;
      try { intentSnapshot = submissionOwnerIntent(ownerIntent); } catch { intentSnapshot = null; }
      const markerStartedAt = Date.now();
      await db.runTransaction(async transaction => {
        // All proof dependencies are reread in the same transaction as the
        // irreversible-send marker, before any write or external send.
        const submissionDoc = await transaction.get(ref);
        requireOwnClaim(submissionDoc.data(), ['portal', 'owner_extension']);
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef)]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        if (!assistedApplicationRetained(orderDoc.data(), nowMs)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        if (!submissionFlowAllowsSend(flowDoc.data(), guardedRound, submissionDoc.data()?.[key]?.channel)) throw Object.assign(new Error('submission_approval_changed'), { code: 'submission_approval_changed' });
        if (submissionDoc.data()?.[key]?.channel === 'owner_extension' && !intentSnapshot) throw Object.assign(new Error('submission_intent_changed'), { code: 'evidence_source_changed' });
        const proof = await armHandoff(transaction, submissionDoc.data(), nowMs, currentAnswerSourceGuard, { slotHash: submissionSlotHash({ orderId, order: orderDoc.data() }),
          draftMaterialHash: submissionDraftMaterialHash(draftDoc.data()), attemptMaterialHash: submissionAttemptMaterialHash(draftDoc.data()) });
        const handoffAt = nowMs + Math.max(0, Date.now() - markerStartedAt);
        if (!assistedApplicationRetained(orderDoc.data(), handoffAt)) throw Object.assign(new Error('submission_retention_changed'), { code: 'submission_retention_changed' });
        if (intentSnapshot) {
          let currentIntent; try { currentIntent = submissionOwnerIntent(ownerIntent); } catch { currentIntent = null; }
          if (JSON.stringify(currentIntent) !== JSON.stringify(intentSnapshot)) throw Object.assign(new Error('submission_intent_changed'), { code: 'evidence_source_changed' });
        }
        transaction.set(proof.ref, { ...proof.frame, handoffAt, ...(intentSnapshot ? { ownerIntent: intentSnapshot } : {}) });
        transaction.set(ref, { [key]: { clickedAt: handoffAt } }, { merge: true });
      });
    },
    async markSent(record = {}, nowMs = Date.now()) {
      await ref.set({ [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
    },
    /** Cleanup is CAS-protected too: a newer claim/receipt keeps its dossier. */
    async clearReleasedAttempt() {
      return db.runTransaction(async transaction => {
        const [submissionDoc, draftDoc, flowDoc] = await Promise.all([transaction.get(ref), transaction.get(draftRef), transaction.get(flowRef)]);
        const current = submissionDoc.data()?.[key];
        if (!claimedAttemptId || current?.state !== 'failed' || current.attemptId !== claimedAttemptId) return false;
        const draft = draftDoc.data();
        if (!draft) return true;
        if (Number(draft.round) !== guardedRound || Number(flowDoc.data()?.round) !== guardedRound) return false;
        if (!draft.sentAttempt) return true;
        if (draft.sentAttempt.submissionAttempt?.id !== claimedAttemptId
          || Number(draft.sentAttempt.submissionAttempt?.round) !== guardedRound) return false;
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
