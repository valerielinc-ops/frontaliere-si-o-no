/** Only recoverable pre-send stops resume after engine changes; CAPTCHA stays with Valerie. */
import { provenOptionalOperationalPortalQuestion } from './lib/portalNativeContract.js';
import { candidateAnswersForQuestions, candidateQuestionAnswerKey, candidateWithEdits, isUnknownAnswer,
  validatedCandidateAnswerForQuestion } from './assistedApplicationCandidateEdits.js';
import { hasAssistedApplicationConsent } from './assistedApplicationConstants.js';
import { operationalQuestionTopic, operationalAnswerReadyForDiscovery, withOperationalQuestionAnswers } from './assistedApplicationOperationalAnswers.js';
import { platformDefaultAnswer } from './assistedApplicationPlatformDefaults.js';
import { isUnconfirmedSubmission } from './assistedApplicationSubmissionGuard.js';
import { validateAnswer } from './lib/answerRules.js';

export const portalCodeVersion = value => /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null;
const RECOVERABLE = new Set(['portal:account', 'portal:account_create_unanswered', 'portal:privacy_not_accepted', 'portal:question_label_unreadable', 'portal:portal_choice_not_registered', 'portal:upload_failed', 'portal:cv_upload_failed', 'portal:posting_mismatch', 'portal:portal_needs_candidate']);

export function portalCodeChanged(flow, version) {
  return Boolean(portalCodeVersion(version)) && flow?.state === 'owner_takeover'
    && flow.heldBy?.length === 1 && RECOVERABLE.has(flow.heldBy[0])
    && flow.portalCodeVersion !== version && flow.portalRecoveryVersion !== version;
}

export function portalRecoveryDefinitelyUnsent({ order, flow, draft, submission = {}, version }) {
  const round = Number(flow?.round) || 1;
  const send = submission[`r${round}`];
  return portalCodeChanged(flow, version) && order?.paymentStatus === 'paid'
    && !order.withdrawnAt && !order.retentionPurgingAt && !order.retentionPurgedAt && !order.retentionPayloadPurgedAt
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent && !draft.sentAttempt
    && send?.state === 'failed' && send.channel === 'portal' && !isUnconfirmedSubmission(send) && Number(send.releasedAt) > 0
    && !Object.values(submission).some(record => record?.state === 'sent' || isUnconfirmedSubmission(record))
    && (flow.heldBy[0] !== 'portal:portal_needs_candidate'
      || !Object.values(submission).some(record => record?.state === 'sending' || isUnconfirmedSubmission(record)));
}

/** A portal email-confirmation hold can resume only when the exact identity answer is known. */
export function portalIdentityQuestionDefinitelyUnsent({ identityQuestionReady = false, questionId, ...context }) {
  return identityQuestionReady === true && portalQuestionHoldsDefinitelyUnsent({ ...context, questionIds: [questionId] });
}

/**
 * A wait on the portal's questions, stopped before any send, that a new engine version may resume: exactly
 * these question holds, an approved round whose submit run never clicked, and nothing that may have left.
 * The caller decides that the current code answers each question (or that it is no question at all).
 */
export function portalQuestionHoldsDefinitelyUnsent({ order, flow, draft, submission = {}, version,
  questionIds = [], approvedRound = false, retentionAllowed = false, receiptVersion }) {
  const round = Number(flow?.round) || 1;
  const send = submission[`r${round}`];
  const ids = Array.isArray(questionIds) ? questionIds.map(id => String(id || '')) : [];
  return Boolean(portalCodeVersion(version)) && approvedRound === true
    && flow?.state === 'needs_candidate_action' && order?.automationState === 'needs_candidate_action'
    && ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length
    && flow.heldBy?.length === ids.length && flow.heldBy.every((held, index) => held === `question:${ids[index]}`)
    && flow.portalCodeVersion !== version && flow.portalRecoveryVersion !== version && receiptVersion !== version
    && order?.paymentStatus === 'paid' && hasAssistedApplicationConsent(order)
    && retentionAllowed === true
    && !order.withdrawnAt && !order.retentionPurgingAt && !order.retentionPurgedAt && !order.retentionPayloadPurgedAt
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && !flow.postingExpiredAt && flow.dispatch?.mode === 'submit' && Number(flow.dispatch.round) === round
    && Number(draft?.completedAt) > 0 && Number(flow.dispatch.requestedAt) >= Number(draft.completedAt)
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent && !draft.sentAttempt
    && send?.state === 'failed' && send.channel === 'portal' && !isUnconfirmedSubmission(send) && Number(send.releasedAt) > 0
    && !Object.values(submission).some(record => record?.state === 'sent' || record?.state === 'sending'
      || isUnconfirmedSubmission(record));
}

const hasAnswer = value => typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value)
    ? value.some(item => ['string', 'number', 'boolean'].includes(typeof item) && String(item).trim())
    : typeof value === 'string' && value.trim().length > 0);
const answerText = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

function optionValues(question) {
  // `options` are candidate-facing labels. `applicationOptions` are ATS
  // source labels and may not match the candidate's saved-language answer.
  const raw = Array.isArray(question?.options) ? question.options : [];
  return [...new Set(raw.flatMap(option => typeof option === 'string' ? [option] : [option?.label, option?.value])
    .map(answerText).filter(Boolean))];
}

/**
 * An unclassified portal question may reopen discovery only when the
 * candidate's saved answer already resolves that exact question. Operational
 * defaults never fill this lane; the normal planner and final-send guard still
 * validate the live control before submission.
 */
function explicitCandidateAnswerReadyForDiscovery(question, answer) {
  if (!hasAnswer(answer)) return false;
  const options = optionValues(question);
  const validationQuestion = {
    ...question,
    type: question?.type || (options.length ? 'choice' : 'text'),
    options,
  };
  const values = Array.isArray(answer) ? answer : [answer];
  return values.length > 0 && values.every(value => {
    const text = answerText(value);
    return Boolean(text) && (!options.length || options.includes(text))
      && validateAnswer(text, validationQuestion).ok;
  });
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
    || !(Number(draft.completedAt) > 0) || !(Number(flow.dispatch.requestedAt) >= Number(draft.completedAt))) return false;
  if (questions.some(question => isUnknownAnswer(flow.answers?.[question.id])
    || isUnknownAnswer(flow.questionAnswers?.[candidateQuestionAnswerKey(question)]))) return false;
  const directAnswers = flow.answers && typeof flow.answers === 'object' ? flow.answers : {};
  const directProjection = candidateAnswersForQuestions(questions, directAnswers, flow.questionAnswers || {}, flow.candidateAnswerHistory || []);
  if (questions.some(question => Object.hasOwn(directAnswers, question.id)
    && (!Object.hasOwn(directProjection, question.id)
      || validatedCandidateAnswerForQuestion(directProjection[question.id], question) === undefined))) return false;
  const { answers, platformFacts } = candidateWithEdits({ order, draft, flow });
  const projected = withOperationalQuestionAnswers(questions, answers, { locale: platformFacts?.locale, facts: platformFacts }).answers;
  return questions.every(question => {
    // Draft-level match questions (for example availability) are not native
    // portal controls. They may travel with a portal hold, but only an
    // explicit, validated candidate answer can clear them; never use an
    // operational default for this lane.
    if (question?.source === 'match') return explicitCandidateAnswerReadyForDiscovery(question, projected[question.id]);
    if (question?.source !== 'portal') return false;
    // A platform default (owner decision 2026-11-09) is as final as an owner preference.
    const platform = platformDefaultAnswer(question, platformFacts)?.value;
    if (platform && platform === projected[question.id]) return true;
    return operationalQuestionTopic(question)
      ? operationalAnswerReadyForDiscovery(question, projected[question.id])
      : explicitCandidateAnswerReadyForDiscovery(question, projected[question.id]);
  });
}
