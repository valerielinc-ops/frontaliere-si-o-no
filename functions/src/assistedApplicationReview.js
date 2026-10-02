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
import { checkDraftTexts, clean, cleanBlock } from './assistedApplicationAiDraftCore.js';
import { rebuildLetterPdf } from './assistedApplicationLetterPdf.js';
import { MAX_PHOTO_BYTES, PHOTO_TYPES, photoAdvice, rebuildInPlaceDocx, rebuildTailoredCvPdf } from './assistedApplicationTailoredCvPdf.js';
import { cvChoiceOf, inPlaceReady } from './assistedApplicationDocxInPlace.js';
import { applyCvLineChoices, checkTailoredCvFacts, cvChoicesOf, ownChoiceTexts } from './assistedApplicationTailoredCv.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { fieldView, formAnswersWithEdits, planCandidateEdits, TEXT_LIMITS } from './assistedApplicationCandidateEdits.js';
import { getReviewTokenSecret, verifyReviewToken } from './assistedApplicationReviewToken.js';
import { followupRefFor } from './assistedApplicationFollowup.js';
import { answerMessage, validateAnswer } from './lib/answerRules.js';
import { decideFollowup, followupReviewPayload } from './assistedApplicationFollowupSweep.js';
import { randomUUID } from 'node:crypto';
import {
  DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_FILES_PER_DOCUMENT,
  detectDocumentType,
  documentFileId,
  documentsView,
  openRequiredDocuments,
  requiredDocumentsOf,
  sanitizeClientCheck,
} from './assistedApplicationExtraDocuments.js';

const ACTIONS = new Set(['approve', 'reject', 'answers', 'confirm_submitted', 'cv_choice', 'edit', 'document_upload', 'document_remove', 'document_waive', 'photo_upload', 'photo_remove', 'cv_lines']);
const PHOTO_ACTIONS = new Set(['photo_upload', 'photo_remove']);
const DOCUMENT_ACTIONS = new Set(['document_upload', 'document_remove', 'document_waive']);
// Where the candidate can still give a document: their review, or a portal waiting for them.
const DOCUMENT_STATES = new Set(['candidate_review', 'needs_candidate_action']);
// What the candidate wrote vouches for itself in the fact check (bounded).
const MAX_CANDIDATE_SOURCE = 20000;
// inplace: the candidate's own Word file with the adapted lines (phase 5), when the runner made one.
const CV_CHOICES = new Set(['tailored', 'original', 'inplace']);
const FOLLOWUP_ACTIONS = new Set(['followup_send', 'followup_skip']);
const MAX_ANSWER_CHARS = 500;
const MIN_FEEDBACK_CHARS = 5;

class ReviewError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function authorize(token, deps) {
  const secret = await (deps.getSecret || getReviewTokenSecret)();
  const verified = verifyReviewToken({ secret, token, nowMs: deps.nowMs });
  if (!verified.ok) throw new ReviewError(verified.error === 'expired' ? 'link_expired' : 'invalid_link', 403);
  return verified;
}

// A start date (availability, "inizio", "Eintritt", "début") is never in the past.
const START_DATE_RE = /availab|disponib|verfügbar|verfuegbar|ab wann|\bstart|inizio|entrata in servizio|beginn|eintritt|antritt|arbeitsbeginn|début|entrée en (fonction|service)|prise de poste|à partir de quand|when can you/i;

/** Today in Zurich, YYYY-MM-DD. */
export function zurichToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

/** The earliest date a date question accepts: today for a start date, else none. */
export function minDateFor(question, nowMs = Date.now()) {
  return question?.type === 'date' && START_DATE_RE.test(`${question.id || ''} ${question.question || ''}`) ? zurichToday(nowMs) : null;
}

/**
 * The proposed start date (owner decision 2026-09-30): the first day of the
 * month three months after next month, e.g. 1 January 2027 in September 2026.
 */
export function defaultStartDate(nowMs = Date.now()) {
  const [year, month] = zurichToday(nowMs).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + 4, 1)).toISOString().slice(0, 10);
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
    // The rule the page checks while the candidate types (answerRules.js).
    validation: question.validation || null,
    // A proposal shown in the field, never an answer until the candidate saves it.
    suggested: minDateFor(question, nowMs) ? defaultStartDate(nowMs) : null,
  };
}

/** What the candidate sees. Built from the draft, never the operator fields. */
/** The ATS check the candidate sees: grade and keyword coverage, before and after tailoring. */
function atsView(report) {
  return report ? { grade: report.structural?.grade || null, keywordCoverage: report.keywords?.coverage ?? null, missing: (report.keywords?.missing || []).slice(0, 8) } : null;
}

export function buildReviewPayload({ order, flow, draft, round, coverLetterUrl, tailoredCvUrl = null, inPlaceCvUrl = null, nowMs = Date.now() }) {
  const current = Number(flow?.round) || 1;
  const state = flow?.state || 'drafting';
  const answers = flow?.answers || {};
  const questions = (draft?.questions || []).map((question) => questionView(question, nowMs));
  const openRequired = questions.filter((question) => question.required && !String(answers[question.id] ?? '').trim());
  // School reports, test results… the posting requires besides the CV and the letter.
  const documents = documentsView(draft, flow);
  const openDocuments = openRequiredDocuments(draft, flow?.documents || {});
  const channel = draft?.channel || {};
  const locale = order?.locale || 'it';
  // With what the candidate changed on this page (assistedApplicationCandidateEdits.js).
  const formAnswers = formAnswersWithEdits({ order, draft, flow });
  const stale = round !== current;
  const ready = Boolean(draft && draft.status === 'ready' && Number(draft.round) === current);
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
    ready,
    coverLetter: draft ? { subject: draft.coverLetter?.subject || '', text: draft.coverLetter?.text || '' } : null,
    coverLetterUrl: coverLetterUrl || null,
    applicationEmail: channel.type === 'email' && draft?.applicationEmail
      ? { to: draft.applicationEmail.to, subject: draft.applicationEmail.subject, body: draft.applicationEmail.body }
      : null,
    formAnswers: formAnswers.map((field) => fieldView(field, { draft, locale })),
    editLimits: TEXT_LIMITS,
    editedAt: draft?.candidateEditedAt || null,
    questions,
    answers: Object.fromEntries(questions.map((question) => [question.id, String(answers[question.id] ?? '')])),
    documents,
    documentLimits: { maxBytes: MAX_DOCUMENT_BYTES, maxFiles: MAX_FILES_PER_DOCUMENT },
    feedback: (flow?.feedback || []).map((item) => ({ round: item.round, text: item.text })),
    // The tailored ATS CV (sent unless the candidate chooses their original).
    tailoredCv: draft?.tailoredCv?.status === 'ready' ? {
      url: tailoredCvUrl,
      choice: cvChoiceOf(draft, flow),
      // The candidate's own Word file with the adapted lines: how many went in, how many kept the CV's line.
      inplace: inPlaceReady(draft) ? {
        url: inPlaceCvUrl,
        patched: (draft.tailoredCv.inplace.patched || []).length,
        kept: (draft.tailoredCv.inplace.skipped || []).length,
      } : null,
      // The optional photo: customary in German-speaking Switzerland, optional elsewhere.
      photo: Boolean(flow?.photo?.key),
      photoAdvice: photoAdvice(draft.language),
      photoMaxBytes: MAX_PHOTO_BYTES,
      // What the tailored CV changed, line by line, with the candidate's choices.
      changes: cvChangesView(draft, flow),
    } : null,
    ats: draft?.ats ? { original: atsView(draft.ats.original), tailored: atsView(draft.ats.tailored) } : null,
    can: {
      approve: !stale && state === 'candidate_review' && openRequired.length === 0 && openDocuments.length === 0,
      reject: !stale && state === 'candidate_review',
      answer: !stale && (state === 'candidate_review' || state === 'needs_candidate_action'),
      uploadDocuments: !stale && DOCUMENT_STATES.has(state) && documents.length > 0,
      confirmSubmitted: !stale && state === 'candidate_handoff',
      chooseCv: !stale && state === 'candidate_review' && draft?.tailoredCv?.status === 'ready',
      // A tailored CV kept on the draft can be rebuilt with a photo (drafts from before it was kept cannot).
      uploadPhoto: !stale && state === 'candidate_review' && draft?.tailoredCv?.status === 'ready' && Boolean(draft.tailoredCv.cv),
      reviewCvLines: !stale && state === 'candidate_review' && draft?.tailoredCv?.status === 'ready' && Boolean(draft.tailoredCv.cv),
      edit: !stale && state === 'candidate_review' && ready,
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

/**
 * The answers kept, each checked with its question's rule, the same check the
 * page runs while the candidate types (functions/src/lib/answerRules.js). Any
 * failure refuses the whole save with a message per field.
 */
export function sanitizeAnswers(raw, draft, nowMs = Date.now(), locale = 'it') {
  const allowed = new Map((draft?.questions || []).map((question) => [question.id, question]));
  const todayIso = zurichToday(nowMs);
  const out = {};
  const fields = {};
  for (const [id, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const question = allowed.get(id);
    if (!question) continue;
    const text = clean(value, MAX_ANSWER_CHARS);
    // Clearing an answer is always allowed; an open required one is caught on approval.
    const view = { ...question, required: false, minDate: minDateFor(question, nowMs) };
    const result = validateAnswer(text, view, { todayIso });
    if (!result.ok) {
      fields[id] = answerMessage(result, view, locale);
      continue;
    }
    out[id] = text;
  }
  if (Object.keys(fields).length) throw new ReviewError('invalid_answers', 400, { fields });
  return out;
}

/**
 * The candidate's changes to the letter, the e-mail and the fields, before
 * approving (no flow event: the submission reads them). The letter PDF is
 * rebuilt when its text or the header (name, phone, place) changes; the
 * candidate's own words become a fact source.
 */
async function saveCandidateEdits({ db, bucket, orderId, order, flow, draft, body, nowMs }) {
  const locale = order?.locale || 'it';
  const plan = planCandidateEdits(body, { order, draft, flow, locale });
  if (Object.keys(plan.errors).length) throw new ReviewError('invalid_edits', 400, { fields: plan.errors });
  if (!plan.changed.length) return [];
  const nextFlow = { ...flow, formOverrides: { ...(flow.formOverrides || {}), ...plan.overrides } };
  const next = { ...draft, ...plan.draftPatch };
  const factSources = {
    ...(draft.factSources || {}),
    candidate: [draft.factSources?.candidate || '', plan.candidateText].filter(Boolean).join('\n').slice(-MAX_CANDIDATE_SOURCE),
  };
  const motivation = Object.fromEntries((next.formAnswers || []).map((field) => [field.key, field.value]));
  const factCheck = checkDraftTexts({
    coverLetter: next.coverLetter?.text,
    emailSubject: next.applicationEmail?.subject,
    emailBody: next.applicationEmail?.body,
    motivationShort: motivation.motivationShort,
    whyCompany: motivation.whyCompany,
  }, factSources, { language: draft.language });

  let coverLetterPdfKey = draft.coverLetterPdfKey;
  let coverLetterRenderer = null;
  if ((plan.draftPatch.coverLetter || plan.identityChanged) && bucket) {
    const rebuilt = await rebuildLetterPdf({ order, orderId, draft: next, flow: nextFlow, letter: next.coverLetter, nowMs });
    coverLetterPdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${draft.round || 1}-candidate-${nowMs}.pdf`;
    coverLetterRenderer = rebuilt.renderer;
    await bucket.file(coverLetterPdfKey).save(rebuilt.pdf, { contentType: 'application/pdf', resumable: false });
  }
  // The tailored CV prints the same header: a corrected name, phone or place rebuilds it too.
  const tailored = plan.identityChanged
    ? await rebuildTailoredCvPdf({ bucket, order, orderId, draft: next, flow: nextFlow, nowMs })
    : null;
  await draftRefFor(db, orderId).set({
    ...plan.draftPatch,
    factSources,
    factCheck: { ...factCheck, basis: draft.factCheck?.basis || null },
    coverLetterPdfKey,
    ...(tailored ? { tailoredCv: { pdfKey: tailored.pdfKey, renderer: tailored.renderer } } : {}),
    // Which writer produced the letter now on the draft.
    ...(coverLetterRenderer ? { coverLetterRenderer } : {}),
    candidateEditedAt: nowMs,
  }, { merge: true });
  if (Object.keys(plan.overrides).length) {
    await flowRefFor(db, orderId).set({ formOverrides: nextFlow.formOverrides, updatedAt: nowMs }, { merge: true });
  }
  await orderRefFor(db, orderId).collection('events').doc().set(buildAssistedApplicationEvent('automation_candidate_edited', {
    actor: 'candidate',
    changed: plan.changed,
    fields: Object.keys(plan.overrides),
  }));
  return plan.changed;
}

const CV_CHOICE_USES = new Set(['adapted', 'original', 'own']);
const MAX_OWN_CV_LINE = 300;

/** The tailored CV's changes as the review page shows them: the summary and each rewritten line, original beside adapted. */
export function cvChangesView(draft, flow) {
  const cv = draft?.tailoredCv?.cv;
  if (!cv) return null;
  const choices = cvChoicesOf(draft, flow);
  const view = (id, adapted, original) => ({ id, adapted, original, use: choices[id]?.use || 'adapted', text: choices[id]?.text || '' });
  return {
    summary: cv.summary ? view('summary', cv.summary, String(draft.profile?.summary || '')) : null,
    roles: (cv.experience || []).filter((role) => role.rewritten && role.lines?.length).map((role) => ({
      title: role.role,
      employer: role.employer,
      lines: role.lines.map((line) => view(line.id, line.text, line.original)),
    })),
  };
}

/**
 * The candidate's line-by-line choices on the tailored CV (idea of
 * Resume-Matcher, per line instead of all or nothing): the adapted text, the
 * CV's own line or the candidate's own words. The fact gate runs again on the
 * result (the candidate's own words vouch for themselves, as letter edits do)
 * and the PDF is rebuilt.
 */
async function saveCvLineChoices({ db, bucket, orderId, order, flow, draft, body, nowMs }) {
  const cv = draft.tailoredCv.cv;
  const known = new Map([
    ...(cv.summary ? [['summary', { original: String(draft.profile?.summary || '') }]] : []),
    ...(cv.experience || []).flatMap((role) => (role.lines || []).map((line) => [line.id, line])),
  ]);
  const choices = {};
  const fields = {};
  for (const [id, raw] of Object.entries(body.choices && typeof body.choices === 'object' ? body.choices : {})) {
    const line = known.get(id);
    if (!line || !raw || !CV_CHOICE_USES.has(raw.use)) continue;
    if (raw.use === 'original' && !line.original) { fields[id] = 'no_original'; continue; }
    const text = raw.use === 'own' ? clean(raw.text, MAX_OWN_CV_LINE + 1) : '';
    if (raw.use === 'own' && (!text || text.length > MAX_OWN_CV_LINE)) { fields[id] = text ? 'too_long' : 'empty'; continue; }
    choices[id] = raw.use === 'own' ? { use: 'own', text } : { use: raw.use };
  }
  if (Object.keys(fields).length) throw new ReviewError('invalid_cv_choices', 400, { fields });
  const applied = applyCvLineChoices(cv, choices, { profile: draft.profile });
  const facts = checkTailoredCvFacts(applied, {
    cvText: draft.factSources?.text || '',
    profile: draft.profile,
    answers: { ...(flow.answers || {}), own: ownChoiceTexts(choices).join('\n'), candidate: draft.factSources?.candidate || '' },
  });
  if (!facts.ok) throw new ReviewError('cv_fact_check_failed', 409, { unsupported: facts.unsupported.map((item) => item.token).slice(0, 5) });
  const cvChoicesRound = Number(draft.round) || 1;
  const nextFlow = { ...flow, cvChoices: choices, cvChoicesRound };
  const rebuilt = await rebuildTailoredCvPdf({ bucket, order, orderId, draft, flow: nextFlow, nowMs });
  if (!rebuilt) throw new ReviewError('not_allowed', 409);
  // The same choices in the candidate's own Word file, when there is one.
  const inplace = await rebuildInPlaceDocx({ bucket, order, orderId, draft, flow: nextFlow, nowMs });
  await flowRefFor(db, orderId).set({ cvChoices: choices, cvChoicesRound, updatedAt: nowMs }, { merge: true });
  await draftRefFor(db, orderId).set({ tailoredCv: { pdfKey: rebuilt.pdfKey, renderer: rebuilt.renderer, ...(inplace ? { inplace } : {}) } }, { merge: true });
  await orderRefFor(db, orderId).collection('events').doc().set(buildAssistedApplicationEvent('automation_candidate_cv_reviewed', {
    actor: 'candidate',
    kept: Object.values(choices).filter((choice) => choice.use === 'adapted').length,
    original: Object.values(choices).filter((choice) => choice.use === 'original').length,
    own: Object.values(choices).filter((choice) => choice.use === 'own').length,
  }));
  return choices;
}

/**
 * The candidate's photo for the tailored CV: given (a JPG or PNG by its bytes,
 * at most 2 MB) or taken back. The tailored CV is rebuilt with or without it;
 * the photo lives in the order's folder, so the retention deletes it with the
 * order.
 */
async function savePhotoChange({ db, bucket, orderId, order, flow, draft, action, body, nowMs }) {
  if (!bucket) throw new ReviewError('storage_unavailable', 503);
  let photo = null;
  if (action === 'photo_upload') {
    const base64 = String(body.contentBase64 || '');
    if (base64.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4) throw new ReviewError('photo_too_large', 413);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new ReviewError('invalid_file');
    if (buffer.length > MAX_PHOTO_BYTES) throw new ReviewError('photo_too_large', 413);
    const type = detectDocumentType(buffer.subarray(0, 16));
    if (!PHOTO_TYPES.has(type)) throw new ReviewError('photo_type_not_allowed');
    const key = `assisted-application-uploads/${orderId}/photo-${nowMs}-${randomUUID().slice(0, 8)}.${type}`;
    await bucket.file(key).save(buffer, { contentType: DOCUMENT_CONTENT_TYPES[type], resumable: false });
    photo = { key, detectedType: type, size: buffer.length, uploadedAt: nowMs };
  }
  const nextFlow = { ...flow, photo };
  const rebuilt = await rebuildTailoredCvPdf({ bucket, order, orderId, draft, flow: nextFlow, nowMs });
  if (!rebuilt) {
    if (photo) await bucket.file(photo.key).delete().catch(() => {});
    throw new ReviewError('not_allowed', 409);
  }
  await flowRefFor(db, orderId).set({ photo, updatedAt: nowMs }, { merge: true });
  await draftRefFor(db, orderId).set({ tailoredCv: { pdfKey: rebuilt.pdfKey, renderer: rebuilt.renderer, photo: Boolean(photo) } }, { merge: true });
  if (flow?.photo?.key && flow.photo.key !== photo?.key) await bucket.file(flow.photo.key).delete().catch(() => {});
  return Boolean(photo);
}

/**
 * One change to a requested document: a file uploaded (its real type from its
 * bytes, the browser's verdict recorded as given), a file removed, or the
 * candidate's choice to send without it (or to take that choice back).
 */
async function saveDocumentChange({ db, bucket, orderId, flow, requested, action, body, nowMs }) {
  const flowRef = flowRefFor(db, orderId);
  const filesOf = (current) => (Array.isArray(current?.documents?.[requested.id]?.files) ? current.documents[requested.id].files : []);
  if (action === 'document_upload') {
    const base64 = String(body.contentBase64 || '');
    if (base64.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4) throw new ReviewError('file_too_large', 413);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) throw new ReviewError('invalid_file');
    if (buffer.length > MAX_DOCUMENT_BYTES) throw new ReviewError('file_too_large', 413);
    const type = detectDocumentType(buffer.subarray(0, 16));
    if (!type) throw new ReviewError('file_type_not_allowed');
    if (filesOf(flow).length >= MAX_FILES_PER_DOCUMENT) throw new ReviewError('too_many_files', 409);
    const key = `assisted-application-uploads/${orderId}/doc-${requested.id.slice(0, 30)}-${nowMs}-${randomUUID().slice(0, 8)}.${type}`;
    if (!bucket) throw new ReviewError('storage_unavailable', 503);
    await bucket.file(key).save(buffer, { contentType: DOCUMENT_CONTENT_TYPES[type], resumable: false });
    const file = { key, name: clean(body.fileName, 120) || `${requested.id}.${type}`, size: buffer.length, detectedType: type, uploadedAt: nowMs, clientCheck: sanitizeClientCheck(body.clientCheck) };
    const added = await db.runTransaction(async (transaction) => {
      const current = (await transaction.get(flowRef)).data() || {};
      const files = filesOf(current);
      if (files.length >= MAX_FILES_PER_DOCUMENT) return false;
      // A file given is no longer "sent without": the choice is taken back.
      transaction.set(flowRef, { documents: { [requested.id]: { files: [...files, file], waivedAt: null } }, updatedAt: nowMs }, { merge: true });
      return true;
    });
    if (!added) {
      await bucket.file(key).delete().catch(() => {});
      throw new ReviewError('too_many_files', 409);
    }
    return;
  }
  if (action === 'document_remove') {
    const fileId = String(body.fileId || '');
    let removed = null;
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.get(flowRef)).data() || {};
      const files = filesOf(current);
      removed = files.find((file) => documentFileId(file.key) === fileId) || null;
      if (!removed) return;
      transaction.set(flowRef, { documents: { [requested.id]: { files: files.filter((file) => file !== removed) } }, updatedAt: nowMs }, { merge: true });
    });
    if (!removed) throw new ReviewError('invalid_file');
    if (bucket) await bucket.file(removed.key).delete().catch(() => {});
    return;
  }
  // document_waive: the candidate's choice, after the warning that the employer may discard the application.
  await flowRef.set({ documents: { [requested.id]: { waivedAt: body.waive === false ? null : nowMs } }, updatedAt: nowMs }, { merge: true });
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
      const [coverLetterUrl, tailoredCvUrl, inPlaceCvUrl] = await Promise.all([
        sign(draft?.coverLetterPdfKey),
        sign(draft?.tailoredCv?.status === 'ready' ? draft.tailoredCv.pdfKey : null),
        sign(inPlaceReady(draft) ? draft.tailoredCv.inplace.docxKey : null),
      ]);
      return { status: 200, body: buildReviewPayload({ order, flow, draft, round, coverLetterUrl, tailoredCvUrl, inPlaceCvUrl, nowMs }) };
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
    const { order, flow, draft } = await loadAll(deps.db, orderId);
    if (Number(flow.round || 1) !== round) throw new ReviewError('stale_link', 409);

    if (action === 'cv_choice') {
      // Which CV leaves: no flow event, the next submission reads it.
      const choice = String(body.cvChoice || '');
      if (!CV_CHOICES.has(choice) || draft?.tailoredCv?.status !== 'ready' || (choice === 'inplace' && !inPlaceReady(draft))) throw new ReviewError('invalid_cv_choice');
      if (flow.state !== 'candidate_review') throw new ReviewError('not_allowed', 409);
      await flowRefFor(deps.db, orderId).set({ cvChoice: choice, updatedAt: nowMs }, { merge: true });
      return { status: 200, body: { ok: true, state: flow.state, cvChoice: choice } };
    }
    if (action === 'edit') {
      if (flow.state !== 'candidate_review' || !draft || draft.status !== 'ready' || Number(draft.round) !== round) {
        throw new ReviewError('not_allowed', 409);
      }
      const changed = await saveCandidateEdits({ db: deps.db, bucket: deps.bucket, orderId, order, flow, draft, body, nowMs });
      return { status: 200, body: { ok: true, state: flow.state, changed } };
    }
    if (action === 'cv_lines') {
      if (flow.state !== 'candidate_review' || draft?.tailoredCv?.status !== 'ready' || !draft.tailoredCv.cv) throw new ReviewError('not_allowed', 409);
      const choices = await saveCvLineChoices({ db: deps.db, bucket: deps.bucket, orderId, order, flow, draft, body, nowMs });
      return { status: 200, body: { ok: true, state: flow.state, choices } };
    }
    if (PHOTO_ACTIONS.has(action)) {
      if (flow.state !== 'candidate_review' || draft?.tailoredCv?.status !== 'ready' || !draft.tailoredCv.cv) throw new ReviewError('not_allowed', 409);
      const photo = await savePhotoChange({ db: deps.db, bucket: deps.bucket, orderId, order, flow, draft, action, body, nowMs });
      return { status: 200, body: { ok: true, state: flow.state, photo } };
    }
    if (DOCUMENT_ACTIONS.has(action)) {
      if (!DOCUMENT_STATES.has(flow.state)) throw new ReviewError('not_allowed', 409);
      const requested = requiredDocumentsOf(draft).find((item) => item.id === String(body.documentId || ''));
      if (!requested) throw new ReviewError('invalid_document');
      await saveDocumentChange({ db: deps.db, bucket: deps.bucket, orderId, flow, requested, action, body, nowMs });
      // The holds are evaluated again: the last document given starts the 12 h clock,
      // or (a portal waiting) sends the application again.
      const result = await applyAutomationEvent({
        db: deps.db, orderId, event: { type: 'candidate_answers' }, actor: 'candidate', runEffect: deps.runEffect, nowMs,
      });
      return { status: 200, body: { ok: true, state: result.flow?.state || flow.state } };
    }
    if (action === 'answers') {
      const answers = sanitizeAnswers(body.answers, draft, nowMs, order?.locale || 'it');
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
    if (error instanceof ReviewError) return { status: error.status, body: { ok: false, error: error.code, ...(error.details || {}) } };
    throw error;
  }
}
