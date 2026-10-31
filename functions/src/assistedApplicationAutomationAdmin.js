import { loadNativeTargetContext } from './assistedApplicationNativeTargetContext.js';
import { nativeOperationRemainingMs } from './lib/assistedApplicationNativeOperation.js';
import { OWNER_NATIVE_PROOF_PROTOCOL, ownerFinalIntent } from './lib/ownerFinalIntent.js';
import { loadRunnerAnswerContext } from './assistedApplicationAnswerEvidence.js';
import { answerQuestionDescriptor, nativeQuestionOptionsView } from './lib/applicationQuestionContract.js';
import { answerContractsFor, currentAnswerReviewRequired, answerSourceRetained } from './assistedApplicationAnswerConfirmation.js';
/**
 * Owner-queue side of the automated assisted application: what Valerie sees
 * (state, clocks, why the flow is held, the full draft with the operator
 * analysis) and what she can do (start, approve — acknowledging warnings —,
 * take over, resume, regenerate, edit the texts, answer on the candidate's
 * behalf). Called by assistedApplicationAdminCore.js behind the verified
 * owner gate.
 */

import {
  checkDraftTexts,
  clean,
  cleanBlock,
  letterText,
  parseLetterText,
} from './assistedApplicationAiDraftCore.js';
import { randomUUID, createHash } from 'node:crypto';
import { portalRetryDueAt } from './assistedApplicationPortalRetryPolicy.js';
import { rebuildLetterPdf } from './assistedApplicationLetterPdf.js';
import { isPlausibleEmail } from './assistedApplicationAiJob.js';
import { candidateWithEdits, factSourcesNow, formAnswersWithEdits, questionsForCandidate } from './assistedApplicationCandidateEdits.js';
import { CvCommitError, saveAnswersWithCv } from './assistedApplicationCvCommit.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { cvChoiceOf, cvToSend } from './assistedApplicationDocxInPlace.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { PORTAL_ACCOUNTS_DOC_ID } from './assistedApplicationConstants.js';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';
import {
  AUTOMATION_SUBCOLLECTION,
  applyAutomationEvent,
  isAutomationEnabledFor,
  draftRefFor,
  flowRefFor,
  orderRefFor,
  startAutomation,
} from './assistedApplicationAutomation.js';
import { ensureOrderAlias } from './assistedApplicationAlias.js';
import { factCheckTokens, roundWasSent } from './assistedApplicationFlow.js';
import { buildFillKit } from './assistedApplicationFillKit.js';
import { MAX_FILES_PER_DOCUMENT, MAX_REQUIRED_DOCUMENTS, documentFileId, extraDocumentsToSend } from './assistedApplicationExtraDocuments.js';
import { retainedArtifactStore } from './lib/assistedApplicationArtifactRetention.js';
import { submissionIrreversibility, publicSubmissionState } from './assistedApplicationSubmissionState.js';
import { submissionGuard, submissionRefFor } from './assistedApplicationSubmissionGuard.js';
import { decryptJson, runKeyFrom } from './lib/evidenceCrypto.js';
import { followupRefFor } from './assistedApplicationFollowup.js';

export const AUTOMATION_ADMIN_ACTIONS = new Set([
  'automationStart',
  'automationApprove',
  'automationTakeover',
  'automationResume',
  'automationRegenerate',
  'automationRetrySubmit',
  'automationHandoff',
  'automationEditDraft',
  'automationSetAnswers',
  'automationRevealAccount',
  'automationFillKit',
  'automationMarkClicked',
  'automationMarkSubmitted',
  'automationVerificationLink',
]);

const OWNER_FLAGS = new Set(['fact_check', 'no_posting', 'channel_unknown', 'legitimacy']);

export class AutomationAdminError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// The record of what left (scripts/assisted-application/lib/submit.mjs `sent`): the letter, the CV and every
// file of every requested document, at most.
const SENT_KINDS = new Set(['letter', 'cv', 'dossier', 'documents', 'document']);
const MAX_SENT_FILES = 2 + MAX_REQUIRED_DOCUMENTS * MAX_FILES_PER_DOCUMENT;

/** The record of what left, each file with a signed link in place of its key. */
async function sentView(sent, sign) {
  if (!sent || typeof sent !== 'object') return null;
  const files = (Array.isArray(sent.files) ? sent.files : []).filter((file) => SENT_KINDS.has(file?.kind)).slice(0, MAX_SENT_FILES);
  const [letterUrl, ...urls] = await Promise.all([sign(sent.letterKey), ...files.map((file) => sign(file.key))]);
  return {
    at: Number(sent.at) || null,
    channel: String(sent.channel || ''),
    packaging: ['separate', 'single', 'portal', 'whatsapp'].includes(sent.packaging) ? sent.packaging : null,
    reason: sent.reason ? String(sent.reason) : null,
    ad: sent.ad === 'single' || sent.ad === 'separate' ? sent.ad : '',
    adCue: String(sent.adCue || ''),
    documentsGrouped: Boolean(sent.documentsGrouped),
    documentsReason: sent.documentsReason ? String(sent.documentsReason) : null,
    pages: Number(sent.pages) || null,
    bytes: Number(sent.bytes) || null,
    letterRenderer: sent.letterRenderer === 'typst' || sent.letterRenderer === 'legacy' ? sent.letterRenderer : null,
    // A send whose outcome was uncertain, confirmed afterwards (assistedApplicationAutomation.js confirmSentAttempt).
    confirmedBy: sent.confirmedBy === 'owner' || sent.confirmedBy === 'acknowledgement' ? sent.confirmedBy : null,
    letterUrl: letterUrl || null,
    files: files.map((file, index) => ({ kind: file.kind, name: String(file.name || ''), url: urls[index] || null })),
  };
}

/** Flow + draft as the owner queue shows them (no raw CV text). */
export async function loadAutomationForAdmin(db, orderId, { signUrl } = {}) {
  const [flowSnapshot, draftSnapshot, inboxSnapshot, accountsSnapshot, followupSnapshot, orderSnapshot] = await Promise.all([
    flowRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
    // Only the latest ten, from the database: an order may collect many messages.
    orderRefFor(db, orderId).collection('inbox').orderBy('receivedAt', 'desc').limit(10).get(),
    orderRefFor(db, orderId).collection(AUTOMATION_SUBCOLLECTION).doc(PORTAL_ACCOUNTS_DOC_ID).get(),
    followupRefFor(db, orderId).get(),
    orderRefFor(db, orderId).get(),
  ]);
  // Extras: the follow-ups of an e-mail application and the interview prep pack.
  const followupDoc = followupSnapshot.exists ? followupSnapshot.data() || {} : null;
  const followup = followupDoc ? {
    state: followupDoc.state || null,
    sent: Number(followupDoc.sent) || 0,
    dueAt: followupDoc.dueAt || null,
    stopReason: followupDoc.stopReason || null,
    pending: followupDoc.pending ? { n: followupDoc.pending.n, body: followupDoc.pending.body || '', deadlineAt: followupDoc.pending.deadlineAt || null } : null,
  } : null;
  const interviewPrep = orderSnapshot.data()?.interviewPrep || null;
  const flow = flowSnapshot.exists ? flowSnapshot.data() || {} : null;
  const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : null;
  const answerContracts = answerContractsFor({ orderId, order: orderSnapshot.data() || {}, flow: flow || {}, draft: draft || {} });
  const reviewRequired = currentAnswerReviewRequired(flow || {}, draft || {});
  // Portal accounts the runner created on the alias: never the password here.
  // A registration the portal refused left no account (`discarded`, no password).
  const accounts = Object.values(accountsSnapshot.exists ? accountsSnapshot.data() || {} : {})
    .filter((entry) => entry && typeof entry === 'object' && entry.host && entry.passwordEnc)
    .map((entry) => ({
      host: entry.host,
      email: entry.email || '',
      createdAt: entry.createdAt || null,
      verifiedAt: entry.verifiedAt || null,
      lastSignInAt: entry.lastSignInAt || null,
      revealedAt: entry.revealedAt || null,
    }));
  const inbox = (inboxSnapshot.docs || []).map((doc) => doc.data() || {})
    .sort((left, right) => Number(right.receivedAt || 0) - Number(left.receivedAt || 0))
    .slice(0, 10)
    .map((item) => ({
      receivedAt: item.receivedAt || null,
      from: item.from || '',
      subject: item.subject || '',
      category: item.category || (item.status && item.status !== 'processed' ? 'processing' : 'other'),
      summaryIt: item.summaryIt || '',
      interviewWhen: item.interviewWhen || '',
      forwarded: item.forwarded?.status || null,
    }));
  if (!flow && !draft && !inbox.length && !accounts.length && !followup && !orderSnapshot.data()?.candidateAlias?.address) return null;
  // One signature per key and load: the CV that left is usually the tailored CV signed here already.
  const signatures = new Map();
  const signed = (key) => {
    if (!key || !signUrl || !isAssistedApplicationCvKey(orderId, key)) return null;
    if (!signatures.has(key)) signatures.set(key, signUrl(key).catch(() => null));
    return signatures.get(key);
  };
  const inPlaceKey = draft?.tailoredCv?.inplace?.status === 'ready' ? draft.tailoredCv.inplace.docxKey : null;
  const [letterUrl, tailoredCvUrl, inPlaceUrl, sent] = await Promise.all([signed(draft?.coverLetterPdfKey), signed(draft?.tailoredCv?.pdfKey), signed(inPlaceKey), sentView(draft?.sent, signed)]);
  const candidateState = draft ? candidateWithEdits({ order: orderSnapshot.data() || {}, draft, flow }) : { profile: {}, answers: {} };
  return {
    answerContracts,
    reviewRequired,
    inbox,
    candidateAlias: orderSnapshot.data()?.candidateAlias?.address || null,
    accounts,
    followup,
    interviewPrep: interviewPrep ? { status: interviewPrep.status || 'preparing', sentAt: interviewPrep.sentAt || null, questions: interviewPrep.questions || 0, stories: interviewPrep.stories || 0 } : null,
    flow: flow ? {
      state: flow.state || null,
      answerReviewRequired: reviewRequired,
      round: Number(flow.round) || 1,
      deadlineAt: flow.deadlineAt || null,
      reminderAt: flow.reminderAt || null,
      portalAutoRetryAt: portalRetryDueAt(flow),
      heldBy: flow.heldBy || [],
      feedback: flow.feedback || [],
      answers: candidateState.answers,
      // The fields the candidate corrected on the review page.
      formOverrides: flow.formOverrides || {},
      dispatch: flow.dispatch || null,
      // The round reached its sending (the candidate approved it): only then may the robot be asked to send it again.
      roundSent: roundWasSent(flow),
      history: (flow.history || []).slice(-12),
    } : null,
    draft: draft ? {
      status: draft.status || null,
      round: Number(draft.round) || null,
      language: draft.language || null,
      job: draft.job || null,
      liveness: draft.liveness || null,
      channel: draft.channel || null,
      verdict: draft.verdict || null,
      summaryIt: draft.summaryIt || '',
      checksIt: draft.checksIt || [],
      requirements: draft.requirements || [],
      matches: draft.matches || [],
      questions: questionsForCandidate(draft.questions, candidateState.profile, candidateState.answers, flow?.questionAnswers).map(question => {
        const descriptor = answerQuestionDescriptor(question);
        return { ...question, originalQuestionContext: descriptor?.originalNativeContract?.context || '',
          originalQuestionSection: descriptor?.originalNativeContract?.section || '',
          ...(descriptor ? nativeQuestionOptionsView(descriptor) : {}),
          ...(!answerContracts[question.id] ? { contractUnavailable: true } : {}) };
      }),
      coverLetter: draft.coverLetter || null,
      applicationEmail: draft.applicationEmail || null,
      formAnswers: formAnswersWithEdits({ order: orderSnapshot.data() || {}, draft, flow }),
      factCheck: draft.factCheck || null,
      factCheckAcknowledgedAt: draft.factCheckAcknowledgedAt || null,
      editedAt: draft.editedAt || null,
      candidateEditedAt: draft.candidateEditedAt || null,
      cvTextMethod: draft.cvTextMethod || null,
      coverLetterUrl: letterUrl,
      // Which renderer made each PDF: `legacy` is the standard-font fallback (assistedApplicationPdfRenderer.js).
      coverLetterRenderer: draft.coverLetterRenderer || null,
      ats: draft.ats || null,
      legitimacy: draft.legitimacy || null,
      tailoredCv: draft.tailoredCv ? {
        status: draft.tailoredCv.status, dropped: draft.tailoredCv.dropped || [], unsupported: draft.tailoredCv.unsupported || [], url: tailoredCvUrl,
        renderer: draft.tailoredCv.renderer || null,
        // Phase 5: the candidate's own Word file with the adapted lines, or why it fell back to the template.
        inplace: draft.tailoredCv.inplace ? {
          status: draft.tailoredCv.inplace.status,
          reason: draft.tailoredCv.inplace.reason || null,
          patched: (draft.tailoredCv.inplace.patched || []).length,
          kept: (draft.tailoredCv.inplace.skipped || []).map((item) => item.reason),
          pageCheck: draft.tailoredCv.inplace.pageCheck || null,
          url: inPlaceUrl || null,
        } : null,
      } : null,
      // The choice that holds: an in-place file no longer offered reads as the tailored CV, as it is sent.
      cvChoice: cvChoiceOf(draft, flow),
      // What the candidate chose on the review page: when it differs from the line above, their own
      // Word file fell back after they chose it, and the panel says so.
      candidateCvChoice: flow?.cvChoice || null,
      // What the portal already received, for Valerie when she finishes by hand.
      portalAnswers: draft.portalAnswers || null,
      // What left with the application (submit.mjs), each file with a signed link.
      sent,
    } : null,
  };
}

async function editDraft(db, orderId, raw, adminEmail, { bucket, nowMs }) {
  const startedAt = Date.now();
  const freshNow = () => nowMs + Math.max(0, Date.now() - startedAt);
  const orderRef = orderRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const submissionRef = submissionRefFor(db, orderId);
  const [orderSnapshot, draftSnapshot, flowSnapshot, submissionSnapshot] = await Promise.all([orderRef.get(), draftRef.get(), flowRefFor(db, orderId).get(), submissionRef.get()]);
  const initialIrreversibility = submissionIrreversibility({ submission: submissionSnapshot.data() });
  if (initialIrreversibility) throw new AutomationAdminError(initialIrreversibility, 409, { state: publicSubmissionState({ order: orderSnapshot.data(), flow: flowSnapshot.data(), submission: submissionSnapshot.data() }) });
  const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : null;
  if (!draft || draft.status !== 'ready') throw new AutomationAdminError('draft_not_ready', 409);
  // Sent: the letter that left is the candidate's to keep, a later edit would only change their Word copy (P8).
  if (flowSnapshot.data()?.state === 'submitted') throw new AutomationAdminError('draft_submitted', 409);
  const order = orderSnapshot.data() || {};
  if (!orderSnapshot.exists || !answerSourceRetained(order, freshNow())) throw new AutomationAdminError('changed_meanwhile', 409);
  const letterRaw = cleanBlock(raw.coverLetterText, 8000);
  const emailSubject = clean(raw.emailSubject, 300);
  const emailBody = cleanBlock(raw.emailBody, 8000);
  const emailTo = clean(raw.emailTo, 320).toLowerCase();
  if (emailTo && !isPlausibleEmail(emailTo)) throw new AutomationAdminError('invalid_email', 400);

  const coverLetter = letterRaw ? parseLetterText(letterRaw) : draft.coverLetter;
  const text = letterText(coverLetter);
  const applicationEmail = {
    to: emailTo || draft.applicationEmail?.to || '',
    subject: emailSubject || draft.applicationEmail?.subject || '',
    body: emailBody || draft.applicationEmail?.body || '',
  };
  // An address the owner adds turns a portal application into an e-mail one.
  const channel = emailTo && draft.channel?.type !== 'email'
    ? { ...draft.channel, type: 'email', label: 'E-mail', email: emailTo, setBy: 'owner' }
    : draft.channel;
  // With the candidate's permit status of now (decision 8).
  const factCheck = checkDraftTexts({ coverLetter: text, emailSubject: applicationEmail.subject, emailBody: applicationEmail.body },
    factSourcesNow({ order, draft, flow: flowSnapshot.data() || {} }), { language: draft.language });

  let coverLetterPdfKey = draft.coverLetterPdfKey;
  let coverLetterRenderer = null;
  if (letterRaw && bucket) {
    // The header as the candidate corrected it (name, phone, place).
    const rebuilt = await rebuildLetterPdf({ order, orderId, draft, flow: flowSnapshot.data() || {}, letter: coverLetter, nowMs });
    // A name of its own per edit: two edits in the same millisecond never share a file, so the one
    // refused below deletes only its own PDF, never the one the committed draft points to.
    coverLetterPdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${draft.round || 1}-edit-${nowMs}-${randomUUID().slice(0, 8)}.pdf`;
    coverLetterRenderer = rebuilt.renderer;
    const store = retainedArtifactStore({ db, bucket, orderId, round: draft.round || 1, now: freshNow });
    if (!await store.save(coverLetterPdfKey, rebuilt.pdf, { contentType: 'application/pdf' })) throw new AutomationAdminError('changed_meanwhile', 409);
  }
  // Written only on the draft it was built from, as the candidate's own writes are
  // (assistedApplicationReview.js commitRebuild): a candidate edit, a line choice or
  // a photo saved meanwhile changes one of these, and the owner reloads instead of
  // overwriting it unseen.
  const unchanged = (current) => current
    && current.round === draft.round
    && (current.coverLetterPdfKey || null) === (draft.coverLetterPdfKey || null)
    && (current.candidateEditedAt || null) === (draft.candidateEditedAt || null)
    && (current.editedAt || null) === (draft.editedAt || null);
  const committed = await db.runTransaction(async (transaction) => {
    const [current, currentOrder, currentSubmission] = await Promise.all([transaction.get(draftRef), transaction.get(orderRef), transaction.get(submissionRef)]);
    if (submissionIrreversibility({ submission: currentSubmission.data() })) return false;
    if (!current.exists || !unchanged(current.data()) || !currentOrder.exists || !answerSourceRetained(currentOrder.data(), freshNow())) return false;
    transaction.set(draftRef, {
      coverLetter: { ...coverLetter, text, subject: draft.coverLetter?.subject || '' },
      applicationEmail,
      channel,
      factCheck: { ...factCheck, basis: draft.factCheck?.basis || null },
      // An edit is a new text: a previous acknowledgement does not cover it, whichever way it was
      // given (the gate at submit reads both, as the flow does: factCheckAcknowledged).
      factCheckAcknowledgedAt: factCheck.ok ? draft.factCheckAcknowledgedAt || null : null,
      ...(factCheck.ok ? {} : { acknowledgedFlags: { fact_check: null }, factCheckAcknowledgedTokens: null }),
      coverLetterPdfKey,
      ...(coverLetterRenderer ? { coverLetterRenderer } : {}),
      editedAt: nowMs,
      editedBy: adminEmail,
    }, { merge: true });
    return true;
  });
  if (!committed) {
    if (coverLetterPdfKey !== draft.coverLetterPdfKey) {
      await bucket.file(coverLetterPdfKey).delete().catch((error) => console.warn('[assisted-application] owner letter not deleted:', coverLetterPdfKey.split('/').pop(), error?.code || error?.message));
    }
    throw new AutomationAdminError('changed_meanwhile', 409);
  }
  await orderRef.collection('events').doc().set(buildAssistedApplicationEvent('automation_draft_edited', {
    actorEmail: adminEmail,
    factWarnings: factCheck.unsupported.length,
  }));
  return { ok: true, factCheck };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} raw request body (action + fields)
 * @param {string} adminEmail
 * @param {{runEffect:Function, bucket?:object, nowMs?:number}} deps
 */
export async function handleAutomationAdminAction(db, raw, adminEmail, deps) {
  const nowMs = deps.nowMs || Date.now();
  const orderId = clean(raw.orderId, 200);
  if (!orderId) throw new AutomationAdminError('invalid_input');
  const actor = `owner:${adminEmail}`;
  const apply = async (event, patchFlow = null) => {
    const result = await applyAutomationEvent({ db, orderId, event, actor, runEffect: deps.runEffect, nowMs, patchFlow });
    if (!result.ok) throw new AutomationAdminError(result.ignored || 'not_allowed', 409);
    return { ok: true, state: result.flow.state };
  };

  switch (raw.action) {
    case 'automationStart': {
      // The Remote Config flag gates every start, the owner's included: while
      // it is off no flow is created and no runner is dispatched.
      if (!(await (deps.isEnabled || isAutomationEnabledFor)(orderId))) throw new AutomationAdminError('automation_disabled', 409);
      // The order's alias first, as the Firestore trigger does after a verified
      // CV (functions/index.js): an order Valerie starts herself (one paid
      // before the automation was on) gets the same candidature address, its
      // portal accounts, verification links and acknowledgements.
      const result = await startAutomation({
        db,
        orderId,
        runEffect: deps.runEffect,
        nowMs,
        reason: 'owner_request',
        ensureAlias: deps.ensureAlias || ((args) => ensureOrderAlias(args)),
      });
      if (!result.started) throw new AutomationAdminError(result.skipped || 'not_startable', 409);
      return { ok: true, state: 'drafting' };
    }
    case 'automationApprove': {
      const acknowledgements = {};
      if (raw.acknowledgeFactWarnings === true) acknowledgements.factCheckAcknowledgedAt = nowMs;
      // Any other owner flag (no posting text, unknown channel, a suspicious posting) is acknowledged by name.
      const flags = (Array.isArray(raw.acknowledgeFlags) ? raw.acknowledgeFlags : []).filter((flag) => OWNER_FLAGS.has(flag));
      if (flags.length) acknowledgements.acknowledgedFlags = Object.fromEntries(flags.map((flag) => [flag, nowMs]));
      // The fact warnings are confirmed as the owner saw them: a warning found later is not covered.
      if (raw.acknowledgeFactWarnings === true || flags.includes('fact_check')) {
        acknowledgements.factCheckAcknowledgedTokens = factCheckTokens((await draftRefFor(db, orderId).get()).data()?.factCheck);
      }
      if (Object.keys(acknowledgements).length) {
        await draftRefFor(db, orderId).set({ ...acknowledgements, acknowledgedBy: adminEmail }, { merge: true });
      }
      // Refused (409 owner_flags_open) while a flag is still open.
      return apply({ type: 'owner_approve' });
    }
    case 'automationTakeover':
      return apply({ type: 'owner_takeover' });
    case 'automationResume':
      return apply({ type: 'owner_resume' });
    case 'automationRegenerate':
      return apply({ type: 'owner_regenerate' });
    case 'automationRetrySubmit':
      // A submit the fact gate stopped (fact_check_not_acknowledged) leaves again only with the
      // owner's confirmation of the warnings, written to the draft as on approval.
      if (raw.acknowledgeFactWarnings === true) {
        const draftRef = draftRefFor(db, orderId);
        const factCheckAcknowledgedTokens = factCheckTokens((await draftRef.get()).data()?.factCheck);
        await draftRef.set({ factCheckAcknowledgedAt: nowMs, factCheckAcknowledgedTokens, acknowledgedBy: adminEmail }, { merge: true });
      }
      return apply({ type: 'owner_retry_submit' });
    case 'automationHandoff':
      return apply({ type: 'owner_handoff' });
    case 'automationEditDraft':
      return editDraft(db, orderId, raw, adminEmail, { bucket: deps.bucket, nowMs });
    case 'automationSetAnswers': {
      const [orderSnapshot, flowSnapshot, draftSnapshot] = await Promise.all([
        orderRefFor(db, orderId).get(), flowRefFor(db, orderId).get(), draftRefFor(db, orderId).get(),
      ]);
      if (!flowSnapshot.exists) throw new AutomationAdminError('no_flow', 404);
      const allowedIds = new Set((draftSnapshot.data()?.questions || []).map(question => question?.id).filter(id => typeof id === 'string' && id.length <= 1000));
      const answers = {};
      for (const [id, value] of Object.entries(raw.answers && typeof raw.answers === 'object' ? raw.answers : {})) {
        if (allowedIds.has(id)) answers[id] = clean(value, 500);
      }
      // An answer the tailored CV prints (the permit status, the availability): rebuilt and committed with the
      // answers, before the event can dispatch the submission (decision 7), as the candidate's answers are.
      let saved;
      try {
        saved = await saveAnswersWithCv({
          db, bucket: deps.bucket, orderId, order: orderSnapshot.data() || {}, flow: flowSnapshot.data() || {},
          draft: draftSnapshot.exists ? draftSnapshot.data() || null : null, answers, nowMs, answerActor: 'owner',
          answerContracts: raw.answerContracts, requireAnswerContracts: deps.requireAnswerContracts === true,
        });
      } catch (error) {
        if (error instanceof CvCommitError) throw new AutomationAdminError(error.code, error.status, error.details);
        throw error;
      }
      if (saved.reviewRequired) return { ok: true, ...saved };
      const result = await applyAutomationEvent({ db, orderId, event: { type: 'candidate_answers' }, actor, runEffect: deps.runEffect, nowMs });
      return { ok: true, state: result.flow?.state || flowSnapshot.data()?.state };
    }
    case 'automationRevealAccount': {
      // Owner takeover of a portal application: the account the runner
      // created on the alias. Who looked and when is recorded; the password
      // itself is only returned, never stored in clear or logged.
      const host = clean(raw.host, 200).toLowerCase();
      const started = Date.now();
      const freshNow = () => nowMs + Math.max(0, Date.now() - started);
      const orderRef = orderRefFor(db, orderId);
      const ref = orderRef.collection(AUTOMATION_SUBCOLLECTION).doc(PORTAL_ACCOUNTS_DOC_ID);
      const [order, accounts] = await Promise.all([orderRef.get(), ref.get()]);
      if (!order.exists || !assistedApplicationRetained(order.data(), freshNow())) throw new AutomationAdminError('account_retention_closed', 409);
      const [key, entry] = Object.entries(accounts.data() || {}).find(([, value]) => value?.host === host) || [];
      if (!entry?.passwordEnc) throw new AutomationAdminError('no_account', 404);
      const rawKey = deps.runKey ? await deps.runKey() : '';
      if (!rawKey) throw new AutomationAdminError('run_key_missing', 500);
      const { password } = decryptJson(entry.passwordEnc, runKeyFrom(rawKey));
      const sameSource = current => current?.host === entry.host && current?.email === entry.email
        && JSON.stringify(current?.passwordEnc) === JSON.stringify(entry.passwordEnc);
      await db.runTransaction(async transaction => {
        const [currentOrder, currentAccounts] = await Promise.all([transaction.get(orderRef), transaction.get(ref)]);
        if (!currentOrder.exists || !assistedApplicationRetained(currentOrder.data(), freshNow())) throw new AutomationAdminError('account_retention_closed', 409);
        if (!sameSource(currentAccounts.data()?.[key])) throw new AutomationAdminError('account_source_changed', 409);
        // Metadata only: never copy a previously read credential back to disk.
        transaction.set(ref, { [key]: { revealedAt: nowMs, revealedBy: adminEmail } }, { merge: true });
      });
      const [finalOrder, finalAccounts] = await Promise.all([orderRef.get(), ref.get()]);
      if (!finalOrder.exists || !assistedApplicationRetained(finalOrder.data(), freshNow())) throw new AutomationAdminError('account_retention_closed', 409);
      if (!sameSource(finalAccounts.data()?.[key])) throw new AutomationAdminError('account_source_changed', 409);
      return { ok: true, host, email: entry.email || '', password };
    }
    case 'automationFillKit':
      return { ok: true, kit: await fillKitFor(db, orderId, deps, { confirmNotReceived: raw.confirmNotReceived === true, nativeProofProtocol: raw.nativeProofProtocol, nowMs }) };
    case 'automationMarkClicked':
      return authorizeOwnerFinalIntent(db, orderId, raw, deps, nowMs);
    case 'automationVerificationLink':
      return { ok: true, ...(await verificationLinkFor(db, orderId, { sinceMs: Number(raw.since) || 0 })) };
    case 'automationMarkSubmitted': {
      // Both callers name their command explicitly; an incomplete automatic report never becomes a human assertion.
      // Deploy only after the compatible owner client sends manual_owner (the previous backend already accepts it).
      if (!['extension', 'manual_owner'].includes(raw.via)) throw new AutomationAdminError('submission_command_required', 409);
      const via = raw.via === 'extension' ? 'owner_extension' : 'owner';
      const result = await recordOwnerSubmission({ db, orderId, adminEmail, via, round: raw.round, ownerIntent: raw.ownerIntent, runEffect: deps.runEffect, nowMs });
      if (!result.ok) throw new AutomationAdminError(result.ignored, 409);
      return result;
    }
    default:
      throw new AutomationAdminError('invalid_input');
  }
}

/**
 * Valerie sent the application herself (the fill extension, or «Segna come
 * inviata» in either part of the queue): the flow the robot left her closes
 * (owner_submitted) and the round is on record as sent, so no later run or
 * retry presses it again. A flow in any other state is left as it is. When
 * she confirms a robot's send of uncertain outcome, the runner's record of
 * that attempt becomes the record of what left.
 * @returns {Promise<{ok:boolean, state?:string, ignored?:string}>}
 */
export async function recordOwnerSubmission({ db, orderId, adminEmail, via = 'owner', round, ownerIntent = null, runEffect, nowMs = Date.now() }) {
  const startedAt = Date.now(); const freshNow = () => nowMs + Math.max(0, Date.now() - startedAt);
  const flow = (await flowRefFor(db, orderId).get()).data() || {};
  const automatic = via === 'owner_extension';
  const targetRound = automatic ? Number(round) : Number(round ?? flow.round);
  if (!Number.isInteger(targetRound) || targetRound < 1 || targetRound > 20) throw new AutomationAdminError('submission_receipt_invalid_round', 409);
  if (!automatic && flow.state && !['owner_takeover', 'candidate_handoff', 'submitted'].includes(flow.state)) return { ok: false, ignored: 'not_taken_over' };
  // The new outcome writer is part of the atomic backend/runner deployment. No legacy automatic fallback.
  const { adoptConfirmedOwnerIntentReceipt } = await import('./assistedApplicationSubmissionGuard.js');
  if (typeof adoptConfirmedOwnerIntentReceipt !== 'function') throw new AutomationAdminError('submission_receipt_unverified', 409);
  let outcome;
  try {
    outcome = automatic
      ? await adoptConfirmedOwnerIntentReceipt({ db, orderId, round: targetRound, ownerIntent,
        record: { channel: 'owner_extension', confirmedBy: 'owner_extension', confirmedAt: freshNow() }, nowMs: freshNow(), receiptClock: freshNow })
      : await submissionGuard(db, orderId, targetRound, { outcomeAuthority: { kind: 'manual_owner', actor: adminEmail }, receiptClock: freshNow })
        .markSent({ channel: 'owner', by: adminEmail, confirmedBy: 'owner', confirmedAt: freshNow() }, freshNow());
  } catch (error) {
    if (/^submission_(?:intent|receipt|claim)_/.test(String(error?.code || error?.message || ''))) throw new AutomationAdminError(String(error.code || error.message), 409);
    throw error;
  }
  // An observed send survives a later purge/revocation, but can no longer recreate a dossier or notify.
  if (outcome?.minimal) return { ok: true, state: 'submitted', receiptOnly: true };
  const result = await applyAutomationEvent({
    db, orderId, event: { type: 'owner_submitted', round: targetRound }, actor: `owner:${adminEmail}`, runEffect, nowMs: freshNow(), patchFlow: () => ({ submittedVia: via }),
  });
  if (!result.ok) return { ok: true, state: result.state || 'submitted', receiptRecorded: true };
  return { ok: true, state: result.flow.state };
}

const millis = (value) => (typeof value?.toMillis === 'function' ? value.toMillis() : Number(value) || 0);

/**
 * The newest link a portal sent to the order's alias to verify the address
 * (JOIN, giro di prova 2026-10-01: «Verificare l'indirizzo e-mail» after the
 * send click), received since `sinceMs`. assistedApplicationInbound.js keeps
 * only an https link copied verbatim from the e-mail. The fill extension
 * opens it in Valerie's browser, as she would from the e-mail: the alias is
 * ours. Only on an order she sends herself.
 * The lower bound is Valerie's press as the server recorded it
 * (automationMarkClicked, the round guard's clickedAt), never earlier: an
 * older verification e-mail is not this send's (review of #10771). The
 * caller's `sinceMs` counts only when the press was not recorded.
 * @returns {Promise<{url:string, receivedAt:number|null}>}
 */
async function verificationLinkFor(db, orderId, { sinceMs = 0 } = {}) {
  const flow = (await flowRefFor(db, orderId).get()).data() || {};
  if (!['owner_takeover', 'candidate_handoff', 'submitted'].includes(flow.state)) throw new AutomationAdminError('not_taken_over', 409);
  const clickedAt = Number((await submissionGuard(db, orderId, flow.round || 1).read())?.clickedAt) || 0;
  if (clickedAt) sinceMs = clickedAt;
  const inbox = await orderRefFor(db, orderId).collection('inbox').get();
  const newest = inbox.docs.map((doc) => doc.data() || {})
    .filter((item) => item.category === 'verification' && /^https:\/\//i.test(String(item.verificationUrl || '')) && millis(item.receivedAt) >= sinceMs)
    .sort((a, b) => millis(b.receivedAt) - millis(a.receivedAt))[0];
  return newest ? { url: String(newest.verificationUrl), receivedAt: millis(newest.receivedAt) } : { url: '', receivedAt: null };
}

// The orders Valerie completes herself: the robot stopped (owner_takeover).
const FILL_KIT_STATES = new Set(['owner_takeover']);
export { OWNER_NATIVE_PROOF_PROTOCOL } from './lib/ownerFinalIntent.js';
function requireNativeProofProtocol(value) {
  if (value !== OWNER_NATIVE_PROOF_PROTOCOL) throw new AutomationAdminError('extension_update_required', 409);
}
async function ownerSourceFence(work) {
  try { return await work(); } catch (error) {
    if (['evidence_source_changed', 'submission_retention_changed', 'submission_approval_changed', 'submission_claim_changed', 'submission_already_sent', 'native_target_source_unavailable'].includes(error?.code)) throw new AutomationAdminError(error.code, 409);
    throw error;
  }
}

/**
 * The fill kit of one order (assistedApplicationFillKit.js), with signed
 * links to the CV that leaves and to the cover letter. The CV is the file the
 * robot would send (submit.mjs chooseCv): the candidate's own Word file with
 * the adapted lines when they chose it and it is ready, otherwise the
 * tailored one unless they chose their original.
 */
async function fillKitFor(db, orderId, deps, { confirmNotReceived = false, nativeProofProtocol, nowMs = Date.now() } = {}) {
  requireNativeProofProtocol(nativeProofProtocol);
  const startedAt = Date.now();
  const freshNow = () => nowMs + Math.max(0, Date.now() - startedAt);
  const [orderSnapshot, draftSnapshot, flowSnapshot, intakeSnapshot] = await Promise.all([
    orderRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
    flowRefFor(db, orderId).get(),
    orderRefFor(db, orderId).collection('automation').doc('intake').get(),
  ]);
  const flow = flowSnapshot.data() || {};
  const draft = draftSnapshot.data() || {};
  const order = orderSnapshot.data() || {};
  if (!flowSnapshot.exists || !draftSnapshot.exists) throw new AutomationAdminError('no_flow', 404);
  if (!FILL_KIT_STATES.has(flow.state)) throw new AutomationAdminError('not_taken_over', 409);
  const guard = submissionGuard(db, orderId, flow.round || 1);
  const record = await guard.read();
  if (record?.state === 'sent') throw new AutomationAdminError('already_sent', 409);
  // A send button already pressed (by the robot, or by Valerie through the
  // extension) with no confirmation: the application may be at the employer.
  // A kit only once she checked the portal and says it is not there.
  if (record?.state === 'sending' && record.clickedAt) {
    if (!confirmNotReceived) throw new AutomationAdminError('submission_unconfirmed', 409);
    await guard.release('owner: checked on the portal, not received', nowMs);
    // The robot's attempt did not arrive: it is no record of what leaves (submit.mjs `sentAttempt`).
    await draftRefFor(db, orderId).set({ sentAttempt: null }, { merge: true });
  }
  const sign = (key) => (key && deps.signUrl && isAssistedApplicationCvKey(orderId, key) ? deps.signUrl(key).catch(() => null) : null);
  // The CV the runner would send (cvToSend, as chooseCv): the original named by the type of its bytes.
  const cv = cvToSend(draft, flow, order);
  const [cvUrl, letterUrl] = await Promise.all([
    cv.cv === 'original' ? (deps.originalCvUrl ? deps.originalCvUrl(orderId, order) : null) : sign(cv.key),
    sign(draft.coverLetterPdfKey),
  ]);
  // The requested documents the candidate gave, each file a signed link too.
  const extra = await Promise.all(extraDocumentsToSend(draft, flow, orderId).map(async (document) => ({
    ...document,
    files: (await Promise.all(document.files.map(async (file) => ({ url: await sign(file.key), detectedType: file.detectedType })))).filter((file) => file.url),
  })));
  const confirmed = await loadRunnerAnswerContext({ db, orderId, order, flow, draft, intake: intakeSnapshot.data() || null, nowMs: freshNow() });
  if (!confirmed.answerSourceGuard) throw new AutomationAdminError('evidence_source_changed', 409);
  const kit = buildFillKit({
    orderId,
    order,
    draft,
    flow: confirmed.flow,
    localAnswerEvidence: confirmed.localAnswerEvidence, policyAuthority: confirmed.policyAuthority,
    documents: { cv: cvUrl ? { url: cvUrl, extension: cv.extension } : null, coverLetter: letterUrl ? { url: letterUrl } : null, extra },
  });
  const targetContext = await ownerSourceFence(() => loadNativeTargetContext({ order, draft, answerSourceGuard: confirmed.answerSourceGuard }));
  await ownerSourceFence(() => db.runTransaction(transaction => targetContext.sourceGuard.assertInTransaction(transaction)));
  return { ...kit, nativeProofProtocol: OWNER_NATIVE_PROOF_PROTOCOL, nativeTargetContext: targetContext.nativeTargetContext,
    answerSourceFingerprint: targetContext.sourceGuard.fingerprint };
}


/** One stopped human intent is acknowledged only after complete server proof and the atomic send fence. */
async function authorizeOwnerFinalIntent(db, orderId, raw, deps, nowMs) {
  requireNativeProofProtocol(raw.nativeProofProtocol);
  const nativeOperation = deps.nativeOperation;
  const remainingBudget = () => {
    const remaining = nativeOperationRemainingMs(nativeOperation, 5000);
    if (remaining <= 0) throw new AutomationAdminError('native_operation_expired', 409);
    return Math.min(90_000, remaining);
  };
  remainingBudget();
  const startedAt = Date.now(); const freshNow = () => nowMs + Math.max(0, Date.now() - startedAt);
  const orderRef = orderRefFor(db, orderId);
  const [orderSnapshot, flowSnapshot, draftSnapshot, intakeSnapshot] = await Promise.all([
    orderRef.get(), flowRefFor(db, orderId).get(), draftRefFor(db, orderId).get(), orderRef.collection('automation').doc('intake').get(),
  ]);
  const order = orderSnapshot.data() || {}; const flow = flowSnapshot.data() || {}; const draft = draftSnapshot.data() || {};
  if (!orderSnapshot.exists || !answerSourceRetained(order, freshNow())) throw new AutomationAdminError('evidence_source_changed', 409);
  if (!FILL_KIT_STATES.has(flow.state)) throw new AutomationAdminError('not_taken_over', 409);
  let request;
  try { request = ownerFinalIntent(raw, { round: Number(flow.round || 1), nowMs: freshNow() }); }
  catch { throw new AutomationAdminError('native_proof_invalid', 409); }
  const intake = intakeSnapshot.data() || null;
  const confirmed = await loadRunnerAnswerContext({ db, orderId, order, flow, draft, intake, nowMs: freshNow() });
  const targetContext = await ownerSourceFence(() => loadNativeTargetContext({ order, draft,
    answerSourceGuard: confirmed.answerSourceGuard, signal: nativeOperation.signal }));
  remainingBudget();
  if (targetContext.sourceGuard.fingerprint !== request.answerSourceFingerprint) throw new AutomationAdminError('evidence_source_changed', 409);
  // The primary posting and the physical Review/iframe URL are distinct. Only the shared validator can bind them.
  let validateNativeApplicationTarget; let canonicalNativeApplicationFrameUrl;
  try { ({ validateNativeApplicationTarget, canonicalNativeApplicationFrameUrl } = await import('./lib/nativeApplicationTarget.js')); }
  catch { throw new AutomationAdminError('native_proof_destination_changed', 409); }
  if (typeof validateNativeApplicationTarget !== 'function' || typeof canonicalNativeApplicationFrameUrl !== 'function') throw new AutomationAdminError('native_proof_destination_changed', 409);
  const target = validateNativeApplicationTarget({ target: request.proof.target, expected: targetContext.expected });
  if (!target?.owned || target.binding?.frameUrl !== canonicalNativeApplicationFrameUrl(request.proof.frameUrl)) throw new AutomationAdminError('native_proof_destination_changed', 409);
  if (!deps.bucket) throw new AutomationAdminError('native_proof_source_unavailable', 409);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const material = new Map();
  const readMaterial = async (key, keepBytes = false) => {
    remainingBudget();
    if (!isAssistedApplicationCvKey(orderId, key) || !answerSourceRetained(order, freshNow())) throw new AutomationAdminError('native_proof_source_unavailable', 409);
    if (material.has(key)) return material.get(key);
    try {
      const [metadata] = await deps.bucket.file(key).getMetadata();
      remainingBudget();
      if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 1 || Number(metadata.size) > 12 * 1024 * 1024
        || !/^\d+$/.test(String(metadata.generation || ''))) throw new Error('invalid_material');
      const [bytes] = await deps.bucket.file(key, { generation: String(metadata.generation) }).download();
      remainingBudget();
      if (!Buffer.isBuffer(bytes) || bytes.length !== Number(metadata.size)) throw new Error('invalid_material');
      const result = { sha256: digest(bytes), size: bytes.length, generation: String(metadata.generation), ...(keepBytes ? { bytes } : {}) };
      material.set(key, result); return result;
    } catch (error) {
      if (error instanceof AutomationAdminError) throw error;
      throw new AutomationAdminError('native_proof_source_unavailable', 409);
    }
  };
  const original = await readMaterial(order.cvStorageKey, true);
  const selectedCv = cvToSend(draft, flow, order);
  const available = [{ slot: 'cv', kind: 'cv', key: selectedCv.key },
    ...(draft.coverLetterPdfKey ? [{ slot: 'cover_letter', kind: 'cover_letter', key: draft.coverLetterPdfKey }] : []),
    ...extraDocumentsToSend(draft, flow, orderId).flatMap(document => document.files.map(file => ({ slot: document.slot,
      kind: document.kind, key: file.key, documentId: document.id, fileId: documentFileId(file.key),
      requestedDocument: (draft.requiredDocuments || []).find(required => required?.id === document.id) || null })))];
  const docsManifest = [];
  // Only slots actually selected in the fresh DOM need bytes; no parallel buffers of every stored document.
  for (const file of available.filter(file => request.proof.attachments.some(attachment => attachment.slot === file.slot))) {
    const { sha256, size, generation } = await readMaterial(file.key);
    docsManifest.push({ slot: file.slot, kind: file.kind, sha256, size, generation, ...(file.documentId ? {
      documentId: file.documentId, fileId: file.fileId, assigned: true, requestedDocument: file.requestedDocument,
      scope: { orderId, round: Number(flow.round || 1), jobId: order.jobId || null, sourceJobUrl: order.jobUrl || draft.job?.applyUrl || '' },
    } : {}) });
  }
  if (request.proof.attachments.some(file => !docsManifest.some(expected => expected.slot === file.slot && expected.sha256 === file.sha256 && expected.size === file.size))) {
    throw new AutomationAdminError('native_proof_material_changed', 409);
  }
  // These imports exist only in the coherent backend/runner integration. An older callee never grants by ignoring extra arguments.
  let nativeQualificationContext; let verifyNativeApplicationProof;
  try {
    ({ nativeQualificationContext } = await import('./lib/nativeQualificationContext.js'));
    ({ verifyNativeApplicationProof } = await import('./assistedApplicationNativeProof.js'));
  } catch { throw new AutomationAdminError('native_proof_unverified', 409); }
  if (typeof nativeQualificationContext !== 'function' || typeof verifyNativeApplicationProof !== 'function') throw new AutomationAdminError('native_proof_unverified', 409);
  const context = nativeQualificationContext({ order, orderId, draft, cvBuffer: original.bytes, flow: confirmed.flow,
    answerEvidence: confirmed.answerEvidence, localAnswerEvidence: confirmed.localAnswerEvidence,
    answerCounterContext: confirmed.answerCounterContext, answerSourceConflicts: confirmed.answerSourceConflicts,
    rawCounterContext: confirmed.rawCounterContext, policyAuthority: confirmed.policyAuthority,
    applicationIdentity: buildFillKit({ orderId, order, draft, flow: confirmed.flow }).identity, docsManifest, intake });
  if (!context?.scope || context.scope.orderId !== orderId || context.scope.round !== Number(flow.round || 1)) throw new AutomationAdminError('native_proof_unverified', 409);
  context.scope = { ...context.scope, primaryPostingUrl: targetContext.expected.applyUrl,
    sourceProtocol: targetContext.expected.sourceProtocol, jobTitle: targetContext.expected.jobTitle,
    sourceAuthority: targetContext.sourceAuthority };
  await ownerSourceFence(() => db.runTransaction(transaction => targetContext.sourceGuard.assertInTransaction(transaction)));
  const verified = await verifyNativeApplicationProof({ proof: request.proof, context, docsManifest,
    budgetMs: remainingBudget(), signal: nativeOperation.signal });
  remainingBudget();
  if (verified?.status !== 'supported' || !/^[a-f0-9]{64}$/.test(verified.verification?.assessmentHash || '')) throw new AutomationAdminError('native_proof_unverified', 409);
  if (typeof deps.auditNativeIntent !== 'function') throw new AutomationAdminError('native_proof_unverified', 409);
  // Keep every awaited audit before the final source fence/ARM; ACK issuance has no later audit wait.
  await deps.auditNativeIntent({ orderId });
  remainingBudget();
  // Refresh public source semantics after slow verification/audit, before the final transactional source fence.
  const finalTargetContext = await ownerSourceFence(() => loadNativeTargetContext({ order, draft,
    answerSourceGuard: confirmed.answerSourceGuard, signal: nativeOperation.signal }));
  if (finalTargetContext.sourceGuard.fingerprint !== targetContext.sourceGuard.fingerprint) throw new AutomationAdminError('evidence_source_changed', 409);
  remainingBudget();
  const ownerIntent = { idHash: digest(Buffer.from(request.intent.id)), nativeDigest: request.intent.nativeDigest,
    materialDigest: request.intent.materialDigest, submitterDigest: request.intent.submitterDigest, assessmentHash: verified.verification.assessmentHash };
  const sourceGuard = Object.freeze({ fingerprint: finalTargetContext.sourceGuard.fingerprint,
    async assertInTransaction(transaction) {
      await finalTargetContext.sourceGuard.assertInTransaction(transaction);
      // No awaited work follows: the entry deadline includes source reads, verification and claim.
      remainingBudget();
      if (freshNow() - request.intent.capturedAt > 120_000) throw Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });
    },
  });
  // A source changed during the verifier must not create even a resumable pre-click claim.
  await ownerSourceFence(() => db.runTransaction(transaction => sourceGuard.assertInTransaction(transaction)));
  const guard = submissionGuard(db, orderId, flow.round || 1, { answerSourceGuard: sourceGuard });
  const claim = await guard.claim('owner_extension', freshNow(), { resumable: true });
  if (claim.status !== 'claimed') throw new AutomationAdminError(claim.status === 'already_sent' ? 'already_sent' : 'submission_unconfirmed', 409);
  await ownerSourceFence(() => guard.markClicked(freshNow(), { answerSourceGuard: sourceGuard, ownerIntent }));
  // Commit completion can consume the reserve or observe a disconnect. Keep the durable marker, but never mint a late ACK.
  remainingBudget();
  const acknowledgedAt = freshNow();
  return { ok: true, state: flow.state, guard: 'sending', nativeProofProtocol: OWNER_NATIVE_PROOF_PROTOCOL,
    finalIntentId: request.intent.id, round: Number(flow.round || 1), ownerIntent, answerSourceFingerprint: request.answerSourceFingerprint,
    nativeDigest: request.intent.nativeDigest, materialDigest: request.intent.materialDigest, submitterDigest: request.intent.submitterDigest,
    acknowledgedAt, expiresAt: acknowledgedAt + 5000 };
}
