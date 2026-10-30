/** Only technical pre-send stops may resume after the portal engine changes. */
import { isUnconfirmedSubmission, hasRecordedSubmission } from './assistedApplicationSubmissionGuard.js';
import { hasAssistedApplicationConsent } from './assistedApplicationConstants.js';
import { automationEligibility } from './assistedApplicationEligibility.js';

export const portalCodeVersion = value => /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null;
const RECOVERABLE = new Set(['portal:account', 'portal:question_label_unreadable', 'portal:upload_failed', 'portal:cv_upload_failed', 'portal:posting_mismatch', 'portal:portal_needs_candidate', 'portal:captcha_provider_unavailable', 'portal:captcha', 'portal:portal_antibot', 'portal:remote_executor_unavailable']);

export function portalCodeChanged(flow, version) {
  return Boolean(portalCodeVersion(version)) && flow?.state === 'owner_takeover'
    && flow.heldBy?.length === 1 && RECOVERABLE.has(flow.heldBy[0])
    && flow.portalCodeVersion !== version && flow.portalRecoveryVersion !== version;
}

export function portalRecoveryDefinitelyUnsent({ orderId, order, flow, draft, submission = {}, version }) {
  const round = Number(flow?.round) || 1;
  const send = submission[`r${round}`];
  return portalCodeChanged(flow, version) && automationEligibility(order, orderId).eligible && hasAssistedApplicationConsent(order)
    && !order.withdrawnAt && !order.retentionPurgedAt && !hasRecordedSubmission({ order, flow, draft, submission })
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent && !draft.sentAttempt
    && send?.state === 'failed' && send.channel === 'portal' && !send.clickedAt && Number(send.releasedAt) > 0
    && !Object.values(submission).some(record => record?.state === 'sent' || isUnconfirmedSubmission(record));
}
