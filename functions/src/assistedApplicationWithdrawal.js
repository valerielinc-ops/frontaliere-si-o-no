/** Cancellation and slot release share the final-send transaction fence. */
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, acceptedPositionsCount, serviceIsActive } from './applicationConciergeConstants.js';
import { isUnconfirmedSubmission, submissionRefFor } from './assistedApplicationSubmissionGuard.js';

const WITHDRAWABLE = new Set(['drafting', 'owner_review', 'candidate_review', 'regenerating', 'submitting', 'needs_candidate_action', 'owner_takeover', 'failed']);
export const MAX_WITHDRAWAL_REASON_CHARS = 1000;
const MIN_WITHDRAWAL_REASON_CHARS = 3;

export function canWithdrawApplication({ order, flow, draft = null, submission = {} }) {
  const conciergeChild = order?.billingMode === 'application_concierge';
  return Boolean(order?.userId) && (!conciergeChild || Boolean(order?.parentServiceId && order?.parentProposalId))
    && order.paymentStatus === 'paid' && order.submissionStatus !== 'submitted'
    && !order.retentionPurgedAt && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && WITHDRAWABLE.has(flow?.state) && !draft?.sent && !draft?.sentAttempt
    && !Object.values(submission || {}).some(record => record?.state === 'sent' || isUnconfirmedSubmission(record));
}

/**
 * The concierge slot a child application holds: its parent service and proposal, read in `transaction` (every
 * Firestore read comes before the first write). Null for an application that is no concierge child.
 */
export async function readConciergeSlot(transaction, db, order) {
  if (order?.billingMode !== 'application_concierge' || !order.parentServiceId || !order.parentProposalId) return null;
  const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(String(order.parentServiceId));
  const proposalRef = serviceRef.collection('proposals').doc(String(order.parentProposalId));
  const [serviceDoc, proposalDoc] = await Promise.all([transaction.get(serviceRef), transaction.get(proposalRef)]);
  return { serviceRef, proposalRef, service: serviceDoc.data(), proposal: proposalDoc.data() };
}

/**
 * Gives one accepted position back to the service, in the caller's transaction: the proposal is closed
 * (`declined` with `withdrawnAt` and why, the shape the portal shows as withdrawn and the matcher leaves out of
 * its ranking feedback), the counter drops by one and never below zero, and an active service asks the matcher
 * for a replacement through the existing worker. The expiry never moves. The caller marks the child
 * (`conciergeSlotReleasedAt`) in the same transaction, so a second pass releases nothing.
 */
export function releaseConciergeSlot(transaction, slot, { orderId, nowMs, declineReason, requestedBy, requestPrefix }) {
  transaction.set(slot.proposalRef, { status: 'declined', declinedAt: new Date(nowMs), withdrawnAt: nowMs, declineReason }, { merge: true });
  transaction.set(slot.serviceRef, {
    acceptedPositionsCount: Math.max(0, acceptedPositionsCount(slot.service) - 1), updatedAt: new Date(nowMs),
    // Queue replenishment through the existing worker; do not extend expiry.
    ...(serviceIsActive(slot.service, nowMs) ? {
      proposalRefreshRequestId: `${requestPrefix}-${orderId}`, proposalRefreshRequestedBy: requestedBy,
    } : {}),
  }, { merge: true });
}

export class WithdrawalError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

export function normalizeWithdrawalReason(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function requiredWithdrawalReason(value) {
  const reason = normalizeWithdrawalReason(value);
  if (reason.length < MIN_WITHDRAWAL_REASON_CHARS) throw new WithdrawalError('withdrawal_reason_required', 400);
  if (reason.length > MAX_WITHDRAWAL_REASON_CHARS) throw new WithdrawalError('withdrawal_reason_too_long', 400);
  return reason;
}

export async function withdrawAssistedApplication({ db, orderId, round, withdrawalReason, nowMs = Date.now() }) {
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const flowRef = orderRef.collection('automation').doc('flow');
  const draftRef = orderRef.collection('ai_drafts').doc('current');
  const submissionRef = submissionRefFor(db, orderId);
  return db.runTransaction(async transaction => {
    const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
      transaction.get(orderRef), transaction.get(flowRef), transaction.get(draftRef), transaction.get(submissionRef),
    ]);
    const order = orderDoc.data();
    const flow = flowDoc.data();
    if (Number(flow?.round || 1) !== Number(round)) throw new WithdrawalError('stale_link');
    if (flow?.state === 'withdrawn') {
      return {
        ok: true,
        state: 'withdrawn',
        slotReleased: Boolean(order?.conciergeSlotReleasedAt),
      };
    }
    const reason = requiredWithdrawalReason(withdrawalReason);
    if (!canWithdrawApplication({ order, flow, draft: draftDoc.data(), submission: submissionDoc.data() })) {
      throw new WithdrawalError('withdrawal_unavailable');
    }
    const conciergeChild = order?.billingMode === 'application_concierge';
    const slot = conciergeChild ? await readConciergeSlot(transaction, db, order) : null;
    if (conciergeChild && (slot?.service?.userId !== order.userId || slot?.proposal?.status !== 'accepted'
      || slot?.proposal?.childApplicationId !== orderId)) {
      throw new WithdrawalError('withdrawal_unavailable');
    }
    // A portal run may already be filling fields. Its markClicked and an
    // email's claim read this same fence, so exactly one action can win.
    transaction.set(submissionRef, { withdrawnAt: nowMs }, { merge: true });
    transaction.set(flowRef, {
      state: 'withdrawn', withdrawnAt: nowMs, deadlineAt: null, reminderAt: null,
      portalAutoRetryAt: null, heldBy: [], updatedAt: nowMs,
      history: [...(flow.history || []), { at: nowMs, event: 'candidate_withdraw', state: 'withdrawn' }].slice(-40),
    }, { merge: true });
    transaction.set(orderRef, {
      submissionStatus: 'withdrawn', automationState: 'withdrawn', automationDueAt: null,
      withdrawnAt: nowMs, withdrawalReason: reason,
      ...(conciergeChild ? { conciergeSlotReleasedAt: nowMs } : {}),
      updatedAt: nowMs,
    }, { merge: true });
    if (conciergeChild) {
      releaseConciergeSlot(transaction, slot, {
        orderId, nowMs, declineReason: 'candidate_withdrawn', requestedBy: 'candidate_withdrawal', requestPrefix: 'withdraw',
      });
    }
    transaction.set(orderRef.collection('events').doc(), {
      type: 'candidate_withdrawn', actor: 'candidate', at: nowMs, slotReleased: conciergeChild, reason,
    });
    return { ok: true, state: 'withdrawn', slotReleased: conciergeChild };
  });
}
