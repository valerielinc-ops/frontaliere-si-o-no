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
 *   release   the send failed for certain: writes `confirmedNotSent`, keeps
 *             click evidence, and lets a later run try again
 */

import { randomUUID } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { answerSourceGuardMatches } from './assistedApplicationAnswerSourceGuard.js';
import { createSubmissionReceipt } from './lib/submissionReceiptContract.js';

export const SUBMISSION_DOC_ID = 'submission';

// Account failures are deliberately a closed, retention-safe vocabulary. The
// runner may report only these two fields: no portal text, locator, URL,
// credential or candidate answer crosses the event boundary.
export const ACCOUNT_FAILURE_CODES = Object.freeze([
  'no_create_button',
  'no_sign_in_button',
  'login_unobserved',
  'create_unanswered',
  'create_refused',
  'locator_control_error',
  'verification_timeout',
  'verification_unobserved',
  'verification_rejected',
  'auth_steps_exhausted',
  'unknown',
]);
export const ACCOUNT_FAILURE_STAGES = Object.freeze(['login', 'registration', 'verification', 'application', 'unknown']);
const ACCOUNT_FAILURE_FIELDS = Object.freeze(['code', 'stage']);
const EXTERNAL_PROOF_KINDS = new Set(['employer_acknowledgement', 'owner_confirmation', 'candidate_confirmation']);

/** Serialize only the finite admin/read-only account diagnostic shape. */
export function serializeAccountFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ACCOUNT_FAILURE_FIELDS.length || keys.some(key => !ACCOUNT_FAILURE_FIELDS.includes(key))) return null;
  if (!ACCOUNT_FAILURE_CODES.includes(value.code) || !ACCOUNT_FAILURE_STAGES.includes(value.stage)) return null;
  return { code: value.code, stage: value.stage };
}

/** Read a stored diagnostic without exposing or accepting any extra fields. */
export function getAccountFailure(record) {
  return serializeAccountFailure(record?.accountFailure);
}

export function submissionRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(SUBMISSION_DOC_ID);
}

/**
 * The submission may have reached the employer, and nothing confirmed it: a
 * portal after its final click, or an e-mail whose send started. A durable
 * release records the separate proof that the employer did not receive it.
 */
export function isUnconfirmedSubmission(record) {
  if (record?.state === 'failed' && record.confirmedNotSent === true) return false;
  return record?.state !== 'sent' && (Boolean(record?.clickedAt) || (record?.state === 'sending' && record.channel === 'email'));
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
  let activeAttemptId = null;
  return {
    async read() {
      return (await ref.get()).data()?.[key] || null;
    },
    async validateAnswerSources(nowMs = Date.now()) {
      let matches = false;
      await db.runTransaction(async transaction => {
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([
          transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef),
        ]);
        matches = await answerSourceGuardMatches({ db, transaction, guard: answerSourceGuard, orderId,
          order: orderDoc.data() || {}, flow: flowDoc.data() || {}, draft: draftDoc.data() || {}, nowMs });
      });
      return matches;
    },
    /**
     * @param {{resumable?: boolean}} [options] a portal submission: a run that
     *   died BEFORE pressing submit (no clickedAt) left nothing at the
     *   employer, so it may start again; after the click it stays ambiguous
     */
    async claim(channel, nowMs = Date.now(), { resumable = false } = {}) {
      let outcome = null;
      const newAttemptId = randomUUID();
      await db.runTransaction(async (transaction) => {
        const [submissionDoc, orderDoc, flowDoc, draftDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef),
        ]);
        const submission = submissionDoc.data();
        const order = orderDoc.data() || {}; const flow = flowDoc.data() || {}; const draft = draftDoc.data() || {};
        if (submission?.withdrawnAt || order.withdrawnAt || flow.state === 'withdrawn') {
          outcome = { status: 'withdrawn' };
          return;
        }
        if (flowDoc.exists && (Number(flow.round || 1) !== (Number(round) || 1)
          || (channel === 'owner_extension' ? flow.state !== 'owner_takeover' : flow.state !== 'submitting'))) {
          outcome = { status: 'superseded' };
          return;
        }
        let current = submission?.[key];
        if (current?.state === 'sent') {
          outcome = { status: 'already_sent', record: current };
          return;
        }
        // Before confirmedNotSent was persisted, release() already meant that
        // a portal failure was proven before the next retry. Migrate only that
        // narrow legacy shape: an explicit portal failure with click evidence
        // and no field at all. A current `confirmedNotSent: false` remains an
        // unknown outcome and must stay locked.
        const legacyReleasedPortal = current?.state === 'failed'
          && current.channel === 'portal'
          && Number(current.clickedAt) > 0
          && !Object.prototype.hasOwnProperty.call(current, 'confirmedNotSent');
        if (legacyReleasedPortal) {
          current = { ...current, confirmedNotSent: true };
        }
        // Keep click evidence, but allow a retry only when release() also
        // recorded a definitive no-send outcome. An unconfirmed click stays locked.
        if (isUnconfirmedSubmission(current)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        if (current?.state === 'sending' && !(resumable && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        if (!await answerSourceGuardMatches({ db, transaction, guard: answerSourceGuard, orderId, order, flow, draft, nowMs })) {
          outcome = { status: 'answer_source_changed' };
          return;
        }
        const attemptId = current?.state === 'sending' && current.attemptId ? current.attemptId : newAttemptId;
        transaction.set(ref, { [key]: { state: 'sending', channel, attemptId, startedAt: nowMs, clickedAt: null, confirmedNotSent: false } }, { merge: true });
        outcome = { status: 'claimed', resumed: current?.state === 'sending', attemptId };
      });
      activeAttemptId = outcome?.status === 'claimed' ? outcome.attemptId : null;
      return outcome;
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now(), { formBinding = null } = {}) {
      await db.runTransaction(async transaction => {
        const [submissionDoc, orderDoc, flowDoc, draftDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef),
        ]);
        const order = orderDoc.data() || {}; const flow = flowDoc.data() || {}; const draft = draftDoc.data() || {};
        if (submissionDoc.data()?.withdrawnAt || order.withdrawnAt || flow.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        const current = submissionDoc.data()?.[key];
        if (flowDoc.exists && (Number(flow.round || 1) !== (Number(round) || 1)
          || (current?.channel === 'owner_extension' ? flow.state !== 'owner_takeover' : flow.state !== 'submitting'))) {
          throw new Error('submission_superseded');
        }
        if (current?.state !== 'sending') throw new Error('submission_claim_missing');
        if (activeAttemptId && current.attemptId !== activeAttemptId) throw new Error('submission_attempt_superseded');
        if (current.channel === 'portal' && !/^[a-f0-9]{64}$/.test(formBinding || '')) {
          throw new Error('submission_form_unbound');
        }
        if (current.channel === 'portal' && Number(current.clickedAt) > 0) {
          if (current.formBinding === formBinding) return;
          throw new Error('submission_already_clicked');
        }
        if (!await answerSourceGuardMatches({ db, transaction, guard: answerSourceGuard, orderId, order, flow, draft, nowMs })) {
          throw new Error('answer_source_changed');
        }
        transaction.set(ref, { [key]: { clickedAt: nowMs, ...(current.channel === 'portal' ? { formBinding } : {}) } }, { merge: true });
      });
    },
    async markSent(record = {}, nowMs = Date.now(), proof = null, { transaction: sharedTransaction = null } = {}) {
      const proofKind = String(proof?.kind || '');
      const attemptId = String(proof?.attemptId || activeAttemptId || record.attemptId || '');
      const channel = String(record.channel || proof?.channel || '');
      const sentRecord = record.sent && typeof record.sent === 'object' && !Array.isArray(record.sent) ? record.sent : {};
      if (!proof || !attemptId) throw new Error('submission_receipt_proof_missing');
      if (activeAttemptId && attemptId !== activeAttemptId) throw new Error('submission_attempt_superseded');
      if ((proofKind === 'email_provider_accepted' && channel !== 'email')
        || (proofKind === 'portal_success_page' && ['email', 'whatsapp', 'owner', 'owner_extension', 'candidate'].includes(channel))
        || (proofKind === 'candidate_handoff_link' && channel !== 'whatsapp')
        || (proofKind === 'owner_confirmation' && !['owner', 'owner_extension'].includes(channel))
        || (proofKind === 'candidate_confirmation' && channel !== 'candidate')
        || (proofKind === 'owner_confirmation' && proof.evidence?.via !== channel)) {
        throw new Error('submission_receipt_channel_mismatch');
      }
      let durableReceipt = null;
      let receiptOrderPatch = null;
      const persist = async transaction => {
        durableReceipt = null;
        receiptOrderPatch = null;
        // The first durable receipt is immutable. A replay must return the
        // original proof, not replace its timestamp, channel or send record.
        const [submissionSnapshot, orderSnapshot] = await Promise.all([transaction.get(ref), transaction.get(orderRef)]);
        const current = submissionSnapshot.data()?.[key] || {};
        if (!orderSnapshot.exists) throw new Error('submission_receipt_order_missing');
        const candidateConfirmation = proofKind === 'candidate_confirmation';
        const priorCandidateReceipt = current.confirmationReceipts?.candidate;
        if (candidateConfirmation && priorCandidateReceipt) {
          durableReceipt = priorCandidateReceipt;
          return;
        }
        if (current.state === 'sent' && current.receipt) {
          if (!candidateConfirmation || current.receipt.proofKind === proofKind) {
            if (current.attemptId && current.attemptId !== attemptId && !EXTERNAL_PROOF_KINDS.has(proofKind)) {
              throw new Error('submission_attempt_superseded');
            }
            durableReceipt = current.receipt;
            return;
          }
        }
        if (current.attemptId && current.attemptId !== attemptId && !EXTERNAL_PROOF_KINDS.has(proofKind)) {
          throw new Error('submission_attempt_superseded');
        }
        if (!EXTERNAL_PROOF_KINDS.has(proofKind) && current.state !== 'sent' && current.attemptId !== attemptId) {
          throw new Error('submission_attempt_superseded');
        }
        if (proofKind === 'portal_success_page' && current.state !== 'sent'
          && (current.channel !== 'portal' || !Number(current.clickedAt) || !/^[a-f0-9]{64}$/.test(current.formBinding || ''))) {
          throw new Error('submission_form_unbound');
        }
        const sentMaterial = current.state === 'sent' && current.sent && typeof current.sent === 'object'
          ? current.sent : sentRecord;
        const receipt = createSubmissionReceipt({
          orderId: String(orderId), round: Number(round) || 1, attemptId, channel, proofKind,
          evidence: proof.evidence, sentRecord: sentMaterial,
          observedAt: Number(proof.observedAt) || Number(nowMs),
        });
        if (!receipt) throw new Error('submission_receipt_invalid');
        if (candidateConfirmation && current.receipt && current.receipt.proofKind !== proofKind) {
          // Candidate confirmation is a second durable fact after a native
          // handoff. Preserve the first send receipt and its channel/attempt.
          transaction.set(ref, { [key]: {
            ...current,
            confirmationReceipts: { ...(current.confirmationReceipts || {}), candidate: receipt },
          } }, { merge: true });
        } else {
          transaction.set(ref, { [key]: {
            ...current, ...record,
            sent: sentMaterial,
            state: 'sent', sentAt: Number(current.sentAt || record.sentAt) || Number(nowMs), confirmedNotSent: false,
            attemptId: current.attemptId || attemptId,
            receipt,
          } }, { merge: true });
        }
        const dueAt = Number(orderSnapshot.data()?.submissionReceiptDueAt) || 0;
        receiptOrderPatch = {
          submissionReceiptDueAt: dueAt > 0 ? Math.min(dueAt, Number(nowMs)) : Number(nowMs),
          submissionReceiptAttempts: 0,
          submissionReceiptStatus: 'pending', submissionReceiptIssue: null,
        };
        if (!sharedTransaction) transaction.set(orderRef, receiptOrderPatch, { merge: true });
        durableReceipt = receipt;
      };
      if (sharedTransaction) await persist(sharedTransaction);
      else await db.runTransaction(persist);
      return {
        receiptId: durableReceipt.receiptId, attemptId: durableReceipt.attemptId, receipt: durableReceipt,
        ...(sharedTransaction && receiptOrderPatch ? { orderPatch: receiptOrderPatch } : {}),
      };
    },
    async release(reason, nowMs = Date.now(), metadata = {}) {
      const failure = Object.prototype.hasOwnProperty.call(metadata || {}, 'accountFailure')
        ? serializeAccountFailure(metadata.accountFailure)
        : undefined;
      const record = {
        state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs,
        confirmedNotSent: true,
      };
      if (failure) record.accountFailure = failure;
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.data()?.[key]?.state === 'sent') return;
        transaction.set(ref, { [key]: record }, { merge: true });
      });
    },
  };
}
