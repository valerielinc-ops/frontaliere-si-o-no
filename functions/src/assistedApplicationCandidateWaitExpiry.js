/**
 * Owner decision 2026-11-27 («Scadenza con chiusura»): a wait for documents or answers only the candidate can
 * give does not last forever. Until the wait turns 30 days old the candidate gets a weekly reminder; at 30 days
 * the order is closed (`withdrawn`, reason `candidate_requirements_expired`), the candidate is told once in
 * their language, and nothing goes to the employer. The refund follows the Terms the candidate accepted
 * (refundEndsAtStart): promised under the mandates v1/v2, never under v3 or for a concierge child. The refund
 * itself is the one that already exists (assistedApplicationAutomationEffects.js `refund`, retried through
 * `automationRefundDueAt`): there is no second engine.
 *
 * Pure, no I/O: the flow, the sweep and the effects share it.
 */

export const CANDIDATE_REQUIREMENTS_EXPIRED_REASON = 'candidate_requirements_expired';
/** The candidate's e-mail kinds, each sent once per order. */
export const CANDIDATE_REQUIREMENTS_EXPIRED_EMAIL_KIND = 'candidate_requirements_expired';
export const CANDIDATE_REQUIREMENTS_EXPIRED_REFUNDED_EMAIL_KIND = 'candidate_requirements_expired_refunded';
export const CANDIDATE_WAIT_EXPIRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** After Valerie was told the candidate is silent, the candidate is reminded once a week until the expiry. */
export const HELD_WEEKLY_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

/** The next weekly reminder after `nowMs`, or null when it would fall on or after the expiry of the wait. */
export function nextWeeklyReminderAt(since, nowMs) {
  const next = nowMs + HELD_WEEKLY_REMINDER_MS;
  return Number(since) > 0 && next < Number(since) + CANDIDATE_WAIT_EXPIRY_AFTER_MS ? next : null;
}

/** The flow was just closed because the wait for the candidate ran out (and not before). */
export function closedByCandidateWaitExpiry(before, after) {
  return before?.state !== 'withdrawn' && after?.state === 'withdrawn'
    && after?.withdrawnReason === CANDIDATE_REQUIREMENTS_EXPIRED_REASON;
}

/** The order's fields once the expiry closed it (assistedApplicationAutomation.js writes them). */
export function candidateWaitExpiryOrderPatch(flow, nowMs) {
  return {
    submissionStatus: 'withdrawn',
    withdrawnAt: Number(flow?.withdrawnAt) || nowMs,
    withdrawalReason: CANDIDATE_REQUIREMENTS_EXPIRED_REASON,
    withdrawalEvidence: { ...flow.withdrawalEvidence },
    automationRefundDueAt: null,
    updatedAt: nowMs,
  };
}
