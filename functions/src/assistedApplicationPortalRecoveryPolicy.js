/** Only technical pre-send stops may resume after the portal engine changes. */
import { provenOptionalOperationalPortalQuestion } from './lib/portalNativeContract.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { hasAssistedApplicationConsent } from './assistedApplicationConstants.js';
import { operationalQuestionTopic, operationalAnswerReadyForDiscovery, withOperationalQuestionAnswers } from './assistedApplicationOperationalAnswers.js';
import { isUnconfirmedSubmission } from './assistedApplicationSubmissionGuard.js';

export const portalCodeVersion = value => /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null;
const RECOVERABLE = new Set(['portal:account', 'portal:account_create_unanswered', 'portal:question_label_unreadable', 'portal:portal_choice_not_registered', 'portal:upload_failed', 'portal:cv_upload_failed', 'portal:posting_mismatch', 'portal:portal_needs_candidate', 'portal:captcha_provider_unavailable']);

export function portalCodeChanged(flow, version) {
  return Boolean(portalCodeVersion(version)) && flow?.state === 'owner_takeover'
    && flow.heldBy?.length === 1 && RECOVERABLE.has(flow.heldBy[0])
    && flow.portalCodeVersion !== version && flow.portalRecoveryVersion !== version;
}

export function portalRecoveryDefinitelyUnsent({ order, flow, draft, submission = {}, version }) {
  const round = Number(flow?.round) || 1;
  const send = submission[`r${round}`];
  return portalCodeChanged(flow, version) && order?.paymentStatus === 'paid'
    && !order.withdrawnAt && !order.retentionPurgedAt
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent && !draft.sentAttempt
    && send?.state === 'failed' && send.channel === 'portal' && !send.clickedAt && Number(send.releasedAt) > 0
    && !Object.values(submission).some(record => record?.state === 'sent' || isUnconfirmedSubmission(record))
    && (flow.heldBy[0] !== 'portal:portal_needs_candidate'
      || !Object.values(submission).some(record => record?.clickedAt || record?.state === 'sending'));
}

/** This lane only schedules native discovery of resolved operational fields. */
export function operationalPortalRecoveryReady({ order, flow, draft }) {
  if (!flow?.heldBy?.includes('portal:portal_needs_candidate')) return true;
  if (flow.heldBy.length !== 1) return false;
  const questions = (Array.isArray(draft?.questions) ? draft.questions : []).filter(question => {
    if (provenOptionalOperationalPortalQuestion(question, draft)) return false;
    return question?.source === 'portal' || question?.required !== false;
  });
  if (!questions.length || !hasAssistedApplicationConsent(order)
    || flow.dispatch?.mode !== 'submit' || Number(flow.dispatch.round) !== Number(flow.round)
    || !(Number(draft.completedAt) > 0) || !(Number(flow.dispatch.requestedAt) >= Number(draft.completedAt))
    || questions.some(question => question?.source !== 'portal' || !operationalQuestionTopic(question))) return false;
  const { answers } = candidateWithEdits({ order, draft, flow });
  const projected = withOperationalQuestionAnswers(questions, answers).answers;
  return questions.every(question => operationalAnswerReadyForDiscovery(question, projected[question.id]));
}
