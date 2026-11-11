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
  const { answers, platformFacts } = candidateWithEdits({ order, draft, flow: candidateFlow, locale });
  const formAnswers = formAnswersWithEdits({ order, draft, flow: candidateFlow, locale })
    .map(field => fieldView(field, { draft, flow: candidateFlow, locale }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const applicationEmail = draft?.channel?.type === 'email' && draft?.applicationEmail
    ? {
      to: String(draft.applicationEmail.to || ''),
      subject: String(draft.applicationEmail.subject || ''),
      // The body the review page shows: the same platform defaults (assistedApplicationReview.js).
      body: operationalEmailBody(draft, answers, { facts: platformFacts }),
    }
    : null;
  return {
    orderId: String(orderId),
    round: Number(flow?.round) || 1,
    locale,
    // Only what the candidate sees or edits: a technical flow write (a sweep, a reminder, a
    // recovery's updatedAt) must not turn the page's next save into a conflict.
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

/**
 * The answers the candidate sees on the review page, by question id: the runner's validated
 * projection (with the display-only legacy answers, candidateReviewFlow), then the order's
 * confirmed answers over it (candidateEditFlow), the chain the page itself is built from. The
 * only source of the values the review compares: the page's revisions (GET), the values the save
 * reads and compares (POST) and the commit-time guard, which rebuilds it from the transaction's
 * own reads, the runner context included.
 * @param {object} runnerContext loadRunnerAnswerContext's result for this order, flow and draft
 */
export function candidateVisibleAnswers({ orderId, order, flow = {}, draft, runnerContext, nowMs = Date.now() }) {
  const reviewFlow = candidateReviewFlow(flow, runnerContext || { retained: true, flow });
  return candidateEditFlow({ orderId, order, flow: reviewFlow, draft, nowMs }).answers || {};
}

/** A stored answer as the review page compares it: whitespace-normalized text, absent and empty alike. */
export function answerRevisionText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Opaque per-question revision of the answer stored for one question id. It
 * changes only when that answer's stored value changes, never for a write to
 * another answer, a question contract or a timestamp. Keyed with the review
 * secret, so a low-entropy answer cannot be tested against it.
 */
export function answerRevision({ secret, orderId, round, id, value }) {
  const secretKey = typeof secret === 'string' ? secret : '';
  if (!secretKey || !String(orderId || '').trim() || !String(id || '').trim()) return null;
  const key = createHmac('sha256', secretKey).update('assisted-application-answer-revision-v1').digest();
  return createHmac('sha256', key).update(JSON.stringify({ orderId: String(orderId), round: Number(round) || 1,
    id: String(id), value: answerRevisionText(value) })).digest('hex');
}

/** The revisions of the stored answers of the questions shown, by question id. */
export function answerRevisionsFor({ secret, orderId, round, ids = [], answers = {} }) {
  const stored = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  return Object.fromEntries((Array.isArray(ids) ? ids : []).flatMap(id => {
    const revision = answerRevision({ secret, orderId, round, id, value: stored[id] });
    return revision ? [[String(id), revision]] : [];
  }));
}

export function sameCandidateEditSnapshot(left, right) {
  if (typeof left !== 'string' || !/^[a-f0-9]{64}$/.test(left)
    || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
