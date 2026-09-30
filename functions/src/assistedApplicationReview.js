/**
 * Candidate review page API of the automated assisted application.
 *
 * Reached with the signed link of the review e-mails (no login,
 * assistedApplicationReviewToken.js). GET returns what the candidate needs to
 * decide — the letter, the e-mail or portal answers that will leave in their
 * name, the open questions and, after a portal handoff, the kit to finish on
 * the portal. The operator's analysis (verdict, gaps, fact warnings) is never
 * part of it. POST performs one action, only for the round the link belongs
 * to: approve, reject with feedback, answer the questions, confirm a portal
 * submission.
 */

import { MAX_REVIEW_ROUNDS } from './assistedApplicationFlow.js';
import { applyAutomationEvent, draftRefFor, flowRefFor, orderRefFor } from './assistedApplicationAutomation.js';
import { buildFormAnswers, candidateIdentity, clean, cleanBlock } from './assistedApplicationAiDraftCore.js';
import { getReviewTokenSecret, verifyReviewToken } from './assistedApplicationReviewToken.js';

const ACTIONS = new Set(['approve', 'reject', 'answers', 'confirm_submitted']);
const MAX_ANSWER_CHARS = 500;
const MIN_FEEDBACK_CHARS = 5;

class ReviewError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function authorize(token, deps) {
  const secret = await (deps.getSecret || getReviewTokenSecret)();
  const verified = verifyReviewToken({ secret, token, nowMs: deps.nowMs });
  if (!verified.ok) throw new ReviewError(verified.error === 'expired' ? 'link_expired' : 'invalid_link', 403);
  return verified;
}

function questionView(question) {
  return {
    id: question.id,
    question: question.question,
    why: question.why || '',
    type: question.type,
    options: question.options || [],
    required: Boolean(question.required),
  };
}

/** What the candidate sees. Built from the draft, never the operator fields. */
export function buildReviewPayload({ order, flow, draft, round, coverLetterUrl }) {
  const current = Number(flow?.round) || 1;
  const state = flow?.state || 'drafting';
  const answers = flow?.answers || {};
  const questions = (draft?.questions || []).map(questionView);
  const openRequired = questions.filter((question) => question.required && !String(answers[question.id] ?? '').trim());
  const channel = draft?.channel || {};
  const identity = candidateIdentity(order, draft?.profile);
  const motivation = (draft?.formAnswers || []).reduce((acc, field) => ({ ...acc, [field.key]: field.value }), {});
  const formAnswers = draft ? buildFormAnswers({
    identity,
    profile: draft.profile,
    documents: { motivationShort: motivation.motivationShort, whyCompany: motivation.whyCompany },
    answers,
  }) : [];
  const stale = round !== current;
  return {
    ok: true,
    stale,
    state,
    round: current,
    roundsLeft: Math.max(0, MAX_REVIEW_ROUNDS - current),
    deadlineAt: state === 'candidate_review' ? flow?.deadlineAt || null : null,
    locale: order?.locale || 'it',
    job: {
      title: draft?.job?.title || order?.jobTitle || '',
      company: order?.companyName || '',
      jobUrl: order?.jobUrl || '',
      applyUrl: channel.applyUrl || draft?.job?.applyUrl || '',
      channel: channel.type || null,
      channelLabel: channel.label || null,
    },
    ready: Boolean(draft && draft.status === 'ready' && Number(draft.round) === current),
    coverLetter: draft ? { subject: draft.coverLetter?.subject || '', text: draft.coverLetter?.text || '' } : null,
    coverLetterUrl: coverLetterUrl || null,
    applicationEmail: channel.type === 'email' && draft?.applicationEmail
      ? { to: draft.applicationEmail.to, subject: draft.applicationEmail.subject, body: draft.applicationEmail.body }
      : null,
    formAnswers: formAnswers.map(({ key, label, value }) => ({ key, label, value })),
    questions,
    answers: Object.fromEntries(questions.map((question) => [question.id, String(answers[question.id] ?? '')])),
    feedback: (flow?.feedback || []).map((item) => ({ round: item.round, text: item.text })),
    can: {
      approve: !stale && state === 'candidate_review' && openRequired.length === 0,
      reject: !stale && state === 'candidate_review',
      answer: !stale && (state === 'candidate_review' || state === 'needs_candidate_action'),
      confirmSubmitted: !stale && state === 'candidate_handoff',
    },
  };
}

async function loadAll(db, orderId) {
  const [orderSnapshot, flowSnapshot, draftSnapshot] = await Promise.all([
    orderRefFor(db, orderId).get(),
    flowRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
  ]);
  if (!orderSnapshot.exists || !flowSnapshot.exists) throw new ReviewError('not_found', 404);
  return {
    order: orderSnapshot.data() || {},
    flow: flowSnapshot.data() || {},
    draft: draftSnapshot.exists ? draftSnapshot.data() || null : null,
  };
}

function sanitizeAnswers(raw, draft) {
  const allowed = new Map((draft?.questions || []).map((question) => [question.id, question]));
  const out = {};
  for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const question = allowed.get(id);
    if (!question) continue;
    const text = clean(value, MAX_ANSWER_CHARS);
    if (question.type === 'choice' && question.options?.length && text && !question.options.includes(text)) continue;
    out[id] = text;
  }
  return out;
}

/**
 * @param {{method:string, query?:object, body?:object}} req
 * @param {{db, runEffect, getSecret?, signUrl?, nowMs?}} deps
 */
export async function handleAssistedApplicationReview(req, deps) {
  const nowMs = deps.nowMs || Date.now();
  const method = String(req.method || 'GET').toUpperCase();
  try {
    if (method === 'GET') {
      const token = String(req.query?.t || '');
      const { orderId, round } = await authorize(token, { ...deps, nowMs });
      const { order, flow, draft } = await loadAll(deps.db, orderId);
      const coverLetterUrl = draft?.coverLetterPdfKey && deps.signUrl
        ? await deps.signUrl(draft.coverLetterPdfKey).catch(() => null)
        : null;
      return { status: 200, body: buildReviewPayload({ order, flow, draft, round, coverLetterUrl }) };
    }
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');
    if (!ACTIONS.has(action)) throw new ReviewError('invalid_action');
    const { orderId, round } = await authorize(String(body.t || ''), { ...deps, nowMs });
    const { flow, draft } = await loadAll(deps.db, orderId);
    if (Number(flow.round || 1) !== round) throw new ReviewError('stale_link', 409);

    if (action === 'answers') {
      const answers = sanitizeAnswers(body.answers, draft);
      if (!Object.keys(answers).length) throw new ReviewError('no_valid_answers');
      await flowRefFor(deps.db, orderId).set({ answers: { ...(flow.answers || {}), ...answers }, updatedAt: nowMs }, { merge: true });
    }
    const event = {
      approve: { type: 'candidate_approve' },
      reject: { type: 'candidate_reject', feedback: cleanBlock(body.feedback, 2000) },
      answers: { type: 'candidate_answers' },
      confirm_submitted: { type: 'candidate_confirmed_submitted' },
    }[action];
    if (action === 'reject' && event.feedback.length < MIN_FEEDBACK_CHARS) throw new ReviewError('feedback_required');
    const result = await applyAutomationEvent({
      db: deps.db, orderId, event, actor: 'candidate', runEffect: deps.runEffect, nowMs,
    });
    if (!result.ok && action !== 'answers') throw new ReviewError(result.ignored || 'not_allowed', 409);
    return { status: 200, body: { ok: true, state: result.flow?.state || flow.state } };
  } catch (error) {
    if (error instanceof ReviewError) return { status: error.status, body: { ok: false, error: error.code } };
    throw error;
  }
}
