import { roundWasSent } from '../../../functions/src/assistedApplicationFlow.js';
import { hasAssistedApplicationConsent } from '../../../functions/src/assistedApplicationConstants.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from '../../../functions/src/assistedApplicationRetention.js';
import { PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION } from '../../../functions/src/assistedApplicationPortalRetryPolicy.js';
import { advancedToFinalReview, advancedToFinalReviewChecks } from './portal/final-review.mjs';

const CONFIRMATION_CATEGORIES = new Set([
  'auto_acknowledgement', 'interview_invite', 'rejection', 'documents_request', 'question', 'assessment', 'offer',
]);

function inboxHasConfirmationOrPendingMessage(inbox = []) {
  return inbox.some(message => message?.automaticApplicationReceipt === true
    || message?.correlationStatus === 'verified'
    || CONFIRMATION_CATEGORIES.has(String(message?.category || ''))
    || (!message?.processedAt && ['received', 'processing'].includes(String(message?.status || ''))));
}

function submissionHasConfirmation(submission = {}) {
  return Object.values(submission).some(record => record?.state === 'sent'
    || record?.confirmedBy === 'acknowledgement'
    || Boolean(record?.receipt?.receiptId));
}

function orderRetentionAllowed(order, nowMs) {
  const purgeDueAt = retentionPurgeDueAt(order);
  return talentPoolConsentActive(order) || (purgeDueAt !== null && purgeDueAt > nowMs);
}

/** Pure decision for the single, versioned repair of ambiguous final-review clicks. */
export function decideFinalReviewAmbiguousReconciliation({
  order = {}, flow = {}, draft = {}, submission = {}, inbox = [],
  source = null, sourcePathBound = false, postClickSnapshot = null, submissionUrl = '',
  laterVerificationClear = false, laterVerificationFound = false, nowMs = Date.now(),
} = {}) {
  const version = PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION;
  if (flow?.portalFinalReviewAmbiguousRecoveryVersion === version) {
    return { decision: 'already_reconciled', criteria: { versionMarker: true } };
  }

  const round = Number(flow?.round) || 1;
  const roundKey = `r${round}`;
  const send = submission?.[roundKey] || {};
  const applyUrl = String(draft?.channel?.applyUrl || draft?.job?.applyUrl || '');
  const finalUrl = String(source?.evidence?.finalUrl || '');
  const sourceEvidenceAvailable = Boolean(source && typeof source === 'object');
  const sourceEventTypeMatches = source?.event?.type === 'submit_failed';
  const sourceFailureReasonMatches = source?.event?.error === 'portal_ambiguous';
  const sourceRouteMatchesApproval = Boolean(applyUrl && String(source?.applyUrl || '') === applyUrl);
  const ambiguousOutcomeRecorded = Array.isArray(source?.evidence?.finalOutcomes)
    && source.evidence.finalOutcomes.at(-1) === 'ambiguous';
  const heldForAmbiguousPortal = flow?.state === 'owner_takeover'
    && flow?.heldBy?.length === 1 && flow.heldBy[0] === 'portal_ambiguous';
  const sourceIsThisAmbiguousClick = sourcePathBound === true
    && sourceEventTypeMatches && sourceFailureReasonMatches && sourceRouteMatchesApproval && ambiguousOutcomeRecorded;
  const postClickSnapshotAvailable = Boolean(postClickSnapshot && typeof postClickSnapshot.text === 'string');
  const postClickUrlMatchesEvidence = Boolean(finalUrl && postClickSnapshot?.url === finalUrl);
  const postClickPageAvailable = postClickSnapshotAvailable && postClickUrlMatchesEvidence && sourceIsThisAmbiguousClick;
  const finalReviewOptions = {
    url: finalUrl,
    submissionUrl,
    applyUrl,
    sourceProtocol: source?.evidence?.sourceProtocol || null,
    job: draft?.job || {},
  };
  const finalReviewChecks = advancedToFinalReviewChecks(postClickSnapshot, finalReviewOptions);
  const finalReview = postClickPageAvailable && advancedToFinalReview(postClickSnapshot, finalReviewOptions);
  const noConfirmedSend = !submissionHasConfirmation(submission)
    && order?.submissionStatus !== 'submitted'
    && flow?.state !== 'submitted'
    && !draft?.sent;
  const criteria = {
    activePaidOrder: order?.paymentStatus === 'paid'
      && hasAssistedApplicationConsent(order)
      && orderRetentionAllowed(order, nowMs)
      && !order.withdrawnAt && !order.retentionPurgingAt && !order.retentionPurgedAt
      && !order.retentionPayloadPurgedAt
      && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
      && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus),
    approvedRound: roundWasSent(flow, round)
      && !flow?.postingExpiredAt
      && draft?.status === 'ready' && Number(draft.round) === round,
    heldForAmbiguousPortal,
    clickedPortalClaim: send?.state === 'sending' && send.channel === 'portal' && Number(send.clickedAt) > 0,
    sourceEvidenceAvailable,
    sourcePathBound: sourcePathBound === true,
    sourceEventTypeMatches,
    sourceFailureReasonMatches,
    sourceRouteMatchesApproval,
    ambiguousOutcomeRecorded,
    sourceEvidenceMatchesClick: sourceIsThisAmbiguousClick,
    postClickSnapshotAvailable,
    postClickUrlMatchesEvidence,
    postClickPageAvailable,
    evidenceArtifacts: {
      structuredPostClickSnapshot: Boolean(source?.evidence?.afterSubmitSnapshot),
      structuredSnapshotMatchesFinalUrl: Boolean(source?.evidence?.afterSubmitSnapshot?.url
        && source.evidence.afterSubmitSnapshot.url === finalUrl),
      sourcePortalProtocolStored: Boolean(source?.evidence?.sourceProtocol),
      encryptedPostClickScreenshot: typeof source?.evidence?.afterSubmit === 'string'
        && source.evidence.afterSubmit.length > 0,
    },
    finalReview,
    finalReviewChecks,
    noInboxConfirmation: !inboxHasConfirmationOrPendingMessage(inbox),
    noConfirmedSend,
    noLaterFoundVerification: laterVerificationFound !== true,
    laterVerificationResolved: laterVerificationClear === true,
  };

  if (!heldForAmbiguousPortal) return { decision: 'ineligible', criteria };
  if (!criteria.noInboxConfirmation || !criteria.noConfirmedSend || !criteria.noLaterFoundVerification) {
    return { decision: 'confirmation_or_verification_present', criteria };
  }
  if (!Object.values(criteria).every(Boolean)) return { decision: 'unknown', criteria };
  return { decision: 'reconcile', criteria };
}

export { PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION };
