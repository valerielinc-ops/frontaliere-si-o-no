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

import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { createHash } from 'node:crypto';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';

function executionRecordOf(execution) {
  return { executionId: execution.id, executionGeneration: execution.lease.generation, executionSourceSha: execution.sourceSha,
    executionEngineVersion: execution.engineVersion, executionMaterialVersion: execution.materialVersion, executionRound: execution.round,
    executionTokenHash: createHash('sha256').update(execution.lease.token).digest('hex') };
}
function matchesExecutionRecord(record, execution) {
  return record && Object.entries(executionRecordOf(execution)).every(([key, value]) => record[key] === value);
}

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

/** AssistedApplicationUpload.tsx also stamps order.submittedAt when a CV is queued for this
 * service. That legacy field alone never proves delivery to the employer. */
export function hasRecordedSubmission({ order, flow, draft, submission = {} }) {
  return order?.submissionStatus === 'submitted' || flow?.state === 'submitted' || Boolean(flow?.submittedAt) || Boolean(draft?.sent)
    || Object.entries(submission || {}).some(([key, record]) => /^r\d+$/.test(key) && record?.state === 'sent')
    || (Array.isArray(flow?.history) ? flow.history : []).some(entry => entry?.state === 'submitted'
      && ['submit_succeeded', 'submit_acknowledged', 'owner_submitted'].includes(entry.event));
}

export function submissionGuard(db, orderId, round, { execution = null } = {}) {
  const ref = submissionRefFor(db, orderId);
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const key = `r${Number(round) || 1}`;
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
      await db.runTransaction(async (transaction) => {
        const executionContext = execution ? await execution.assertInTransaction(transaction) : null;
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
        if (current?.state === 'sending' && !(resumable && !current.clickedAt)) {
          outcome = { status: 'in_flight', record: current };
          return;
        }
        const identity = executionContext ? executionRecordOf(executionContext.execution) : {};
        transaction.set(ref, { [key]: { state: 'sending', channel, startedAt: nowMs, clickedAt: null, ...identity } }, { merge: true });
        outcome = { status: 'claimed', resumed: current?.state === 'sending' };
      });
      return outcome;
    },
    /** Right before a portal's final submit click: from here the outcome may be unknown. */
    async markClicked(nowMs = Date.now(), { receiptWaitMs = 60_000 } = {}) {
      const deadline = await db.runTransaction(async transaction => {
        const executionContext = execution ? await execution.assertInTransaction(transaction) : null;
        const [submissionDoc, orderDoc, flowDoc] = await Promise.all([
          transaction.get(ref), transaction.get(orderRef), transaction.get(flowRef),
        ]);
        if (submissionDoc.data()?.withdrawnAt || orderDoc.data()?.withdrawnAt || flowDoc.data()?.state === 'withdrawn') {
          throw new Error('application_withdrawn');
        }
        if (executionContext && !matchesExecutionRecord(submissionDoc.data()?.[key], executionContext.execution)) throw new Error('execution_submission_superseded');
        if (executionContext) {
          if (!Number.isFinite(receiptWaitMs) || receiptWaitMs <= 0) throw new Error('execution_receipt_wait_invalid');
          const prior = executionContext.execution.clickProof;
          if (prior && !matchesExecutionRecord(prior, executionContext.execution)) throw new Error('execution_click_superseded');
          if (!prior) transaction.set(orderRef.collection('automation').doc('execution'), {
            clickProof: { ...executionRecordOf(executionContext.execution), clickedAt: nowMs,
              drainUntil: nowMs + Math.min(90_000, receiptWaitMs) },
          }, { merge: true });
        }
        transaction.set(ref, { [key]: { clickedAt: nowMs } }, { merge: true });
        return executionContext ? executionContext.execution.clickProof?.drainUntil || nowMs + Math.min(90_000, receiptWaitMs) : null;
      });
      return deadline;
    },
    async markSent(record = {}, nowMs = Date.now()) {
      const observedAt = Date.now();
      if (execution) return db.runTransaction(async transaction => {
        const context = await execution.assertOutcomeInTransaction(transaction);
        const current = (await transaction.get(ref)).data()?.[key];
        const proof = context.execution.clickProof;
        if (!matchesExecutionRecord(proof, context.execution) || !proof.clickedAt) throw new Error('execution_receipt_unproven');
        const observed = { hash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
          attempt: proof.executionTokenHash, at: nowMs, status: 'sent', round: Number(round) || 1 };
        const receipt = context.execution.minimalReceipt || observed;
        if (receipt.attempt !== observed.attempt || receipt.round !== observed.round || receipt.status !== 'sent'
          || !/^[a-f0-9]{64}$/.test(receipt.hash || '')) throw new Error('execution_receipt_superseded');
        const currentNowMs = nowMs + Math.max(0, Date.now() - observedAt);
        if (!assistedApplicationRetained(context.order, currentNowMs)) {
          transaction.set(orderRef.collection('automation').doc('execution'), { minimalReceipt: receipt }, { merge: true });
          return { minimal: true };
        }
        if (!matchesExecutionRecord(current, context.execution)
          || !current.clickedAt) throw new Error('execution_submission_superseded');
        transaction.set(orderRef.collection('automation').doc('execution'), { minimalReceipt: receipt }, { merge: true });
        transaction.set(ref, { [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
        return { minimal: false };
      });
      await ref.set({ [key]: { state: 'sent', sentAt: nowMs, ...record } }, { merge: true });
    },
    async release(reason, nowMs = Date.now()) {
      if (execution) return db.runTransaction(async transaction => {
        const context = await execution.assertInTransaction(transaction);
        const current = (await transaction.get(ref)).data()?.[key];
        if (!matchesExecutionRecord(current, context.execution)) throw new Error('execution_submission_superseded');
        if (current.clickedAt && !['portal_refused', 'portal_validation'].includes(reason)) throw new Error('execution_ambiguous_release_forbidden');
        transaction.set(ref, { [key]: { state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs } }, { merge: true });
      });
      await ref.set({ [key]: { state: 'failed', reason: String(reason || '').slice(0, 120), releasedAt: nowMs } }, { merge: true });
    },
  };
}
