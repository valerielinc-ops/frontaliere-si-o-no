import { createHmac, timingSafeEqual } from 'node:crypto';
import { candidateWithEdits, fieldView, formAnswersWithEdits, ORDER_QUESTION_ANSWER_EVIDENCE_VERSION } from './assistedApplicationCandidateEdits.js';
import { orderQuestionAnswerContext } from './assistedApplicationAnswerEvidence.js';
import { operationalEmailBody } from './assistedApplicationOperationalAnswers.js';
import { normalizeAnswerCommunicationLocale } from './assistedApplicationAnswerConfirmation.js';

/** Same display-only legacy projection used by the candidate review endpoint. */
export function candidateReviewFlow(flow, runnerContext) {
  if (!runnerContext?.retained) return runnerContext?.flow || flow;
  const displayLegacyAnswers = flow?.orderQuestionAnswersEvidenceVersion !== ORDER_QUESTION_ANSWER_EVIDENCE_VERSION;
  return {
    ...runnerContext.flow,
    answers: { ...(displayLegacyAnswers ? flow?.answers || {} : {}), ...(runnerContext.flow?.answers || {}) },
    questionAnswers: { ...(displayLegacyAnswers ? flow?.questionAnswers || {} : {}), ...(runnerContext.flow?.questionAnswers || {}) },
  };
}

/** One order-local answer projection feeds both the candidate view and its edit snapshot. */
export function candidateEditFlow({ orderId, order, flow = {}, draft, nowMs = Date.now() }) {
  const orderContext = orderQuestionAnswerContext({ orderId, order, flow, draft, nowMs });
  return {
    ...flow,
    answers: { ...(flow?.answers || {}), ...(orderContext.answers || {}) },
    questionAnswers: { ...(flow?.questionAnswers || {}), ...(orderContext.orderAnswers || {}) },
  };
}

/**
 * Opaque, keyed snapshot of the exact candidate-edit contract shown in review.
 * The HMAC keeps low-entropy personal values (phone, permit, residence) out of
 * a reversible/dictionary-testable client digest while still letting the API
 * detect stale forms before and during the write transaction.
 */
export function candidateEditContract({ orderId, order, flow, draft, communicationLocale, nowMs = Date.now() }) {
  const locale = normalizeAnswerCommunicationLocale(communicationLocale)
    || normalizeAnswerCommunicationLocale(order?.locale) || 'it';
  const candidateFlow = candidateEditFlow({ orderId, order, flow, draft, nowMs });
  const { answers } = candidateWithEdits({ order, draft, flow: candidateFlow, locale });
  const formAnswers = formAnswersWithEdits({ order, draft, flow: candidateFlow, locale })
    .map(field => fieldView(field, { draft, flow: candidateFlow, locale }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const applicationEmail = draft?.channel?.type === 'email' && draft?.applicationEmail
    ? {
      to: String(draft.applicationEmail.to || ''),
      subject: String(draft.applicationEmail.subject || ''),
      body: operationalEmailBody(draft, answers),
    }
    : null;
  return {
    orderId: String(orderId),
    round: Number(flow?.round) || 1,
    locale,
    flowUpdatedAt: flow?.updatedAt ?? null,
    candidateEditedAt: draft?.candidateEditedAt ?? null,
    coverLetterText: String(draft?.coverLetter?.text || ''),
    applicationEmail,
    formAnswers,
  };
}

export function candidateEditSnapshot({ secret, orderId, order, flow, draft, communicationLocale, nowMs = Date.now() }) {
  const secretKey = typeof secret === 'string' ? secret : '';
  if (!secretKey || !String(orderId || '').trim()) return null;
  const material = JSON.stringify({ version: 1,
    ...candidateEditContract({ orderId, order, flow, draft, communicationLocale, nowMs }) });
  const key = createHmac('sha256', secretKey).update('assisted-application-edit-snapshot-v1').digest();
  return createHmac('sha256', key).update(material).digest('hex');
}

export function sameCandidateEditSnapshot(left, right) {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/.test(left)
    || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
