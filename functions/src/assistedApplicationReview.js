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
import { followupRefFor } from './assistedApplicationFollowup.js';
import { decideFollowup, followupReviewPayload } from './assistedApplicationFollowupSweep.js';

const ACTIONS = new Set(['approve', 'reject', 'answers', 'confirm_submitted', 'cv_choice']);
const CV_CHOICES = new Set(['tailored', 'original']);
const FOLLOWUP_ACTIONS = new Set(['followup_send', 'followup_skip']);
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

// A start date (availability, "inizio", "Eintritt", "début") is never in the past.
const START_DATE_RE = /availab|disponib|\bstart|inizio|entrata in servizio|beginn|eintritt|antritt|début|entrée en (fonction|service)|prise de poste/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today in Zurich, YYYY-MM-DD. */
export function zurichToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

/** The earliest date a date question accepts: today for a start date, else none. */
export function minDateFor(question, nowMs = Date.now()) {
  return question?.type === 'date' && START_DATE_RE.test(`${question.id || ''} ${question.question || ''}`) ? zurichToday(nowMs) : null;
}

/** A real calendar date (YYYY-MM-DD, year 1900 to ten years ahead), not before `minDate`. */
export function validDateAnswer(text, minDate = null, nowMs = Date.now()) {
  const match = ISO_DATE_RE.exec(String(text || ''));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (year < 1900 || year > new Date(nowMs).getUTCFullYear() + 10) return false;
  return !minDate || text >= minDate;
}

function questionView(question, nowMs = Date.now()) {
  return {
    id: question.id,
    question: question.question,
    why: question.why || '',
    type: question.type,
    options: question.options || [],
    required: Boolean(question.required),
    minDate: minDateFor(question, nowMs),
  };
}

/** What the candidate sees. Built from the draft, never the operator fields. */
/** The ATS check the candidate sees: grade and keyword coverage, before and after tailoring. */
function atsView(report) {
  return report ? { grade: report.structural?.grade || null, keywordCoverage: report.keywords?.coverage ?? null, missing: (report.keywords?.missing || []).slice(0, 8) } : null;
}

export function buildReviewPayload({ order, flow, draft, round, coverLetterUrl, tailoredCvUrl = null, nowMs = Date.now() }) {
  const current = Number(flow?.round) || 1;
  const state = flow?.state || 'drafting';
  const answers = flow?.answers || {};
  const questions = (draft?.questions || []).map((question) => questionView(question, nowMs));
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
    // The link of the round the candidate just sent back: the next version is
    // being prepared, which is what the page says (not "an older version").
    preparingNext: stale && current === Number(round) + 1 && ['regenerating', 'drafting', 'owner_review'].includes(state),
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
    // The tailored ATS CV (sent unless the candidate chooses their original).
    tailoredCv: draft?.tailoredCv?.status === 'ready' ? { url: tailoredCvUrl, choice: flow?.cvChoice === 'original' ? 'original' : 'tailored' } : null,
    ats: draft?.ats ? { original: atsView(draft.ats.original), tailored: atsView(draft.ats.tailored) } : null,
    can: {
      approve: !stale && state === 'candidate_review' && openRequired.length === 0,
      reject: !stale && state === 'candidate_review',
      answer: !stale && (state === 'candidate_review' || state === 'needs_candidate_action'),
      confirmSubmitted: !stale && state === 'candidate_handoff',
      chooseCv: !stale && state === 'candidate_review' && draft?.tailoredCv?.status === 'ready',
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

export function sanitizeAnswers(raw, draft, nowMs = Date.now()) {
  const allowed = new Map((draft?.questions || []).map((question) => [question.id, question]));
  const out = {};
  for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const question = allowed.get(id);
    if (!question) continue;
    const text = clean(value, MAX_ANSWER_CHARS);
    if (question.type === 'choice' && question.options?.length && text && !question.options.includes(text)) continue;
    // Not a date, or a start date in the past: refused, so the candidate corrects it.
    if (question.type === 'date' && text && !validDateAnswer(text, minDateFor(question, nowMs), nowMs)) {
      throw new ReviewError('invalid_date');
    }
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
      const { orderId, round, kind } = await authorize(token, { ...deps, nowMs });
      if (kind === 'followup') {
        const [orderSnapshot, draftSnapshot, followupSnapshot] = await Promise.all([
          orderRefFor(deps.db, orderId).get(), draftRefFor(deps.db, orderId).get(), followupRefFor(deps.db, orderId).get(),
        ]);
        if (!orderSnapshot.exists || !followupSnapshot.exists) throw new ReviewError('not_found', 404);
        return { status: 200, body: followupReviewPayload({ order: orderSnapshot.data(), draft: draftSnapshot.data() || {}, followup: followupSnapshot.data(), n: round }) };
      }
      const { order, flow, draft } = await loadAll(deps.db, orderId);
      const sign = (key) => (key && deps.signUrl ? deps.signUrl(key).catch(() => null) : null);
      const [coverLetterUrl, tailoredCvUrl] = await Promise.all([
        sign(draft?.coverLetterPdfKey),
        sign(draft?.tailoredCv?.status === 'ready' ? draft.tailoredCv.pdfKey : null),
      ]);
      return { status: 200, body: buildReviewPayload({ order, flow, draft, round, coverLetterUrl, tailoredCvUrl, nowMs }) };
    }
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');
    if (!ACTIONS.has(action) && !FOLLOWUP_ACTIONS.has(action)) throw new ReviewError('invalid_action');
    const { orderId, round, kind } = await authorize(String(body.t || ''), { ...deps, nowMs });
    // A follow-up link acts only on its follow-up, a review link only on the review.
    if ((kind === 'followup') !== FOLLOWUP_ACTIONS.has(action)) throw new ReviewError('invalid_action');
    if (kind === 'followup') {
      const result = await decideFollowup({
        db: deps.db, orderId, n: round, decision: action === 'followup_send' ? 'send' : 'skip', nowMs, sendCascade: deps.sendCascade,
      });
      if (!result.ok && result.error === 'not_pending') throw new ReviewError('not_allowed', 409);
      return { status: 200, body: { ok: true, sent: Boolean(result.sent), stopped: Boolean(result.stopped) } };
    }
    const { flow, draft } = await loadAll(deps.db, orderId);
    if (Number(flow.round || 1) !== round) throw new ReviewError('stale_link', 409);

    if (action === 'cv_choice') {
      // Which CV leaves: no flow event, the next submission reads it.
      const choice = String(body.cvChoice || '');
      if (!CV_CHOICES.has(choice) || draft?.tailoredCv?.status !== 'ready') throw new ReviewError('invalid_cv_choice');
      if (flow.state !== 'candidate_review') throw new ReviewError('not_allowed', 409);
      await flowRefFor(deps.db, orderId).set({ cvChoice: choice, updatedAt: nowMs }, { merge: true });
      return { status: 200, body: { ok: true, state: flow.state, cvChoice: choice } };
    }
    if (action === 'answers') {
      const answers = sanitizeAnswers(body.answers, draft, nowMs);
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
