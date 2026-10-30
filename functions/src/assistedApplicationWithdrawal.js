/** Cancellation and slot release share the final-send transaction fence. */
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, acceptedPositionsCount, serviceIsActive } from './applicationConciergeConstants.js';
import { isUnconfirmedSubmission, submissionRefFor } from './assistedApplicationSubmissionGuard.js';

const WITHDRAWABLE = new Set(['drafting', 'owner_review', 'candidate_review', 'regenerating', 'submitting', 'needs_candidate_action', 'owner_takeover', 'failed']);

export function canWithdrawApplication({ order, flow, draft, submission = {} }) {
  return order?.billingMode === 'application_concierge' && Boolean(order?.userId && order?.parentServiceId && order?.parentProposalId)
    && order.paymentStatus === 'paid' && order.submissionStatus !== 'submitted'
    && !order.retentionPurgedAt && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && WITHDRAWABLE.has(flow?.state) && !draft?.sent && !draft?.sentAttempt
    && !Object.values(submission || {}).some(record => record?.state === 'sent' || isUnconfirmedSubmission(record));
}

export class WithdrawalError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 409; }
}

export async function withdrawAssistedApplication({ db, orderId, round, nowMs = Date.now() }) {
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
    if (flow?.state === 'withdrawn' && order?.conciergeSlotReleasedAt) return { ok: true, state: 'withdrawn', slotReleased: true };
    if (!canWithdrawApplication({ order, flow, draft: draftDoc.data(), submission: submissionDoc.data() })) {
      throw new WithdrawalError('withdrawal_unavailable');
    }
    const serviceRef = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(order.parentServiceId);
    const proposalRef = serviceRef.collection('proposals').doc(order.parentProposalId);
    const [serviceDoc, proposalDoc] = await Promise.all([transaction.get(serviceRef), transaction.get(proposalRef)]);
    const service = serviceDoc.data();
    const proposal = proposalDoc.data();
    if (service?.userId !== order.userId || proposal?.status !== 'accepted' || proposal?.childApplicationId !== orderId) {
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
      withdrawnAt: nowMs, conciergeSlotReleasedAt: nowMs, updatedAt: nowMs,
    }, { merge: true });
    transaction.set(proposalRef, { status: 'declined', declinedAt: new Date(nowMs), withdrawnAt: nowMs, declineReason: 'candidate_withdrawn' }, { merge: true });
    transaction.set(serviceRef, {
      acceptedPositionsCount: Math.max(0, acceptedPositionsCount(service) - 1), updatedAt: new Date(nowMs),
      // Queue replenishment through the existing worker; do not extend expiry.
      ...(serviceIsActive(service, nowMs) ? {
        proposalRefreshRequestId: `withdraw-${orderId}`, proposalRefreshRequestedBy: 'candidate_withdrawal',
      } : {}),
    }, { merge: true });
    transaction.set(orderRef.collection('events').doc(), { type: 'candidate_withdrawn', actor: 'candidate', at: nowMs, slotReleased: true });
    return { ok: true, state: 'withdrawn', slotReleased: true };
  });
}
