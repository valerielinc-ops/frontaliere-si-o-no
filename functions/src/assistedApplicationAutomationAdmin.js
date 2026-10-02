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
import { rebuildLetterPdf } from './assistedApplicationLetterPdf.js';
import { isPlausibleEmail } from './assistedApplicationAiJob.js';
import { formAnswersWithEdits } from './assistedApplicationCandidateEdits.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { PORTAL_ACCOUNTS_DOC_ID } from './assistedApplicationConstants.js';
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
import { buildFillKit } from './assistedApplicationFillKit.js';
import { extraDocumentsToSend } from './assistedApplicationExtraDocuments.js';
import { submissionGuard } from './assistedApplicationSubmissionGuard.js';
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

const OWNER_FLAGS = new Set(['fact_check', 'knock_out', 'no_posting', 'channel_unknown', 'legitimacy']);

export class AutomationAdminError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
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
  if (!flow && !draft && !inbox.length && !accounts.length && !followup) return null;
  const signed = (key) => (key && signUrl && isAssistedApplicationCvKey(orderId, key) ? signUrl(key).catch(() => null) : null);
  const [letterUrl, tailoredCvUrl] = await Promise.all([signed(draft?.coverLetterPdfKey), signed(draft?.tailoredCv?.pdfKey)]);
  return {
    inbox,
    accounts,
    followup,
    interviewPrep: interviewPrep ? { status: interviewPrep.status || 'preparing', sentAt: interviewPrep.sentAt || null, questions: interviewPrep.questions || 0, stories: interviewPrep.stories || 0 } : null,
    flow: flow ? {
      state: flow.state || null,
      round: Number(flow.round) || 1,
      deadlineAt: flow.deadlineAt || null,
      reminderAt: flow.reminderAt || null,
      heldBy: flow.heldBy || [],
      feedback: flow.feedback || [],
      answers: flow.answers || {},
      // The fields the candidate corrected on the review page.
      formOverrides: flow.formOverrides || {},
      dispatch: flow.dispatch || null,
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
      questions: draft.questions || [],
      coverLetter: draft.coverLetter || null,
      applicationEmail: draft.applicationEmail || null,
      formAnswers: formAnswersWithEdits({ order: orderSnapshot.data() || {}, draft, flow }),
      factCheck: draft.factCheck || null,
      factCheckAcknowledgedAt: draft.factCheckAcknowledgedAt || null,
      knockOutAcknowledgedAt: draft.knockOutAcknowledgedAt || null,
      editedAt: draft.editedAt || null,
      candidateEditedAt: draft.candidateEditedAt || null,
      cvTextMethod: draft.cvTextMethod || null,
      coverLetterUrl: letterUrl,
      ats: draft.ats || null,
      legitimacy: draft.legitimacy || null,
      tailoredCv: draft.tailoredCv ? { status: draft.tailoredCv.status, dropped: draft.tailoredCv.dropped || [], unsupported: draft.tailoredCv.unsupported || [], url: tailoredCvUrl } : null,
      cvChoice: flow?.cvChoice || 'tailored',
      // What the portal already received, for Valerie when she finishes by hand.
      portalAnswers: draft.portalAnswers || null,
    } : null,
  };
}

async function editDraft(db, orderId, raw, adminEmail, { bucket, nowMs }) {
  const orderRef = orderRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const [orderSnapshot, draftSnapshot, flowSnapshot] = await Promise.all([orderRef.get(), draftRef.get(), flowRefFor(db, orderId).get()]);
  const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : null;
  if (!draft || draft.status !== 'ready') throw new AutomationAdminError('draft_not_ready', 409);
  const order = orderSnapshot.data() || {};
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
  const factCheck = checkDraftTexts({ coverLetter: text, emailSubject: applicationEmail.subject, emailBody: applicationEmail.body }, draft.factSources || {}, { language: draft.language });

  let coverLetterPdfKey = draft.coverLetterPdfKey;
  let coverLetterRenderer = null;
  if (letterRaw && bucket) {
    // The header as the candidate corrected it (name, phone, place).
    const rebuilt = await rebuildLetterPdf({ order, orderId, draft, flow: flowSnapshot.data() || {}, letter: coverLetter, nowMs });
    coverLetterPdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${draft.round || 1}-edit-${nowMs}.pdf`;
    coverLetterRenderer = rebuilt.renderer;
    await bucket.file(coverLetterPdfKey).save(rebuilt.pdf, { contentType: 'application/pdf', resumable: false });
  }
  await draftRef.set({
    coverLetter: { ...coverLetter, text, subject: draft.coverLetter?.subject || '' },
    applicationEmail,
    channel,
    factCheck: { ...factCheck, basis: draft.factCheck?.basis || null },
    // An edit is a new text: a previous acknowledgement does not cover it.
    factCheckAcknowledgedAt: factCheck.ok ? draft.factCheckAcknowledgedAt || null : null,
    coverLetterPdfKey,
    ...(coverLetterRenderer ? { coverLetterRenderer } : {}),
    editedAt: nowMs,
    editedBy: adminEmail,
  }, { merge: true });
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
      if (raw.acknowledgeKnockOut === true) acknowledgements.knockOutAcknowledgedAt = nowMs;
      // Any other owner flag (no posting text, unknown channel, a suspicious posting) is acknowledged by name.
      const flags = (Array.isArray(raw.acknowledgeFlags) ? raw.acknowledgeFlags : []).filter((flag) => OWNER_FLAGS.has(flag));
      if (flags.length) acknowledgements.acknowledgedFlags = Object.fromEntries(flags.map((flag) => [flag, nowMs]));
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
      return apply({ type: 'owner_retry_submit' });
    case 'automationHandoff':
      return apply({ type: 'owner_handoff' });
    case 'automationEditDraft':
      return editDraft(db, orderId, raw, adminEmail, { bucket: deps.bucket, nowMs });
    case 'automationSetAnswers': {
      const flowSnapshot = await flowRefFor(db, orderId).get();
      if (!flowSnapshot.exists) throw new AutomationAdminError('no_flow', 404);
      const answers = {};
      for (const [id, value] of Object.entries(raw.answers && typeof raw.answers === 'object' ? raw.answers : {})) {
        if (/^[a-z0-9_]{1,60}$/.test(id)) answers[id] = clean(value, 500);
      }
      await flowRefFor(db, orderId).set({ answers: { ...(flowSnapshot.data()?.answers || {}), ...answers }, updatedAt: nowMs }, { merge: true });
      const result = await applyAutomationEvent({ db, orderId, event: { type: 'candidate_answers' }, actor, runEffect: deps.runEffect, nowMs });
      return { ok: true, state: result.flow?.state || flowSnapshot.data()?.state };
    }
    case 'automationRevealAccount': {
      // Owner takeover of a portal application: the account the runner
      // created on the alias. Who looked and when is recorded; the password
      // itself is only returned, never stored in clear or logged.
      const host = clean(raw.host, 200).toLowerCase();
      const ref = orderRefFor(db, orderId).collection(AUTOMATION_SUBCOLLECTION).doc(PORTAL_ACCOUNTS_DOC_ID);
      const [key, entry] = Object.entries((await ref.get()).data() || {}).find(([, value]) => value?.host === host) || [];
      if (!entry?.passwordEnc) throw new AutomationAdminError('no_account', 404);
      const rawKey = deps.runKey ? await deps.runKey() : '';
      if (!rawKey) throw new AutomationAdminError('run_key_missing', 500);
      const { password } = decryptJson(entry.passwordEnc, runKeyFrom(rawKey));
      await ref.set({ [key]: { ...entry, revealedAt: nowMs, revealedBy: adminEmail } }, { merge: true });
      return { ok: true, host, email: entry.email || '', password };
    }
    case 'automationFillKit':
      return { ok: true, kit: await fillKitFor(db, orderId, deps, { confirmNotReceived: raw.confirmNotReceived === true, nowMs }) };
    case 'automationMarkClicked': {
      // Valerie pressed the highlighted send button: the extension reports it
      // on the press, before the portal answers. From here the round may have
      // left; no new kit is handed out until the portal confirms or she says
      // it is not there (review of #10759).
      const flow = (await flowRefFor(db, orderId).get()).data() || {};
      if (!FILL_KIT_STATES.has(flow.state)) throw new AutomationAdminError('not_taken_over', 409);
      const guard = submissionGuard(db, orderId, flow.round || 1);
      const claim = await guard.claim('owner_extension', nowMs, { resumable: true });
      if (claim.status === 'claimed') await guard.markClicked(nowMs);
      return { ok: true, state: flow.state, guard: claim.status === 'already_sent' ? 'sent' : 'sending' };
    }
    case 'automationVerificationLink':
      return { ok: true, ...(await verificationLinkFor(db, orderId, { sinceMs: Number(raw.since) || 0 })) };
    case 'automationMarkSubmitted': {
      // The fill extension saw the portal's confirmation, or Valerie says so.
      const via = raw.via === 'extension' ? 'owner_extension' : 'owner';
      const result = await recordOwnerSubmission({ db, orderId, adminEmail, via, runEffect: deps.runEffect, nowMs });
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
 * retry presses it again. A flow in any other state is left as it is.
 * @returns {Promise<{ok:boolean, state?:string, ignored?:string}>}
 */
export async function recordOwnerSubmission({ db, orderId, adminEmail, via = 'owner', runEffect, nowMs = Date.now() }) {
  const flow = (await flowRefFor(db, orderId).get()).data() || {};
  const result = await applyAutomationEvent({
    db, orderId, event: { type: 'owner_submitted' }, actor: `owner:${adminEmail}`, runEffect, nowMs, patchFlow: () => ({ submittedVia: via }),
  });
  if (!result.ok) return { ok: false, ignored: result.ignored || 'not_allowed' };
  await submissionGuard(db, orderId, flow.round || 1).markSent({ channel: via, by: adminEmail }, nowMs);
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
  if (!['owner_takeover', 'submitted'].includes(flow.state)) throw new AutomationAdminError('not_taken_over', 409);
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

/**
 * The fill kit of one order (assistedApplicationFillKit.js), with signed
 * links to the CV that leaves (submit.mjs chooseCv: the tailored one unless
 * the candidate chose their original) and to the cover letter.
 */
async function fillKitFor(db, orderId, deps, { confirmNotReceived = false, nowMs = Date.now() } = {}) {
  const [orderSnapshot, draftSnapshot, flowSnapshot] = await Promise.all([
    orderRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
    flowRefFor(db, orderId).get(),
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
  }
  const sign = (key) => (key && deps.signUrl && isAssistedApplicationCvKey(orderId, key) ? deps.signUrl(key).catch(() => null) : null);
  const tailored = draft.tailoredCv?.status === 'ready' && draft.tailoredCv.pdfKey && flow.cvChoice !== 'original';
  const originalKey = String(order.cvStorageKey || '');
  const [cvUrl, letterUrl] = await Promise.all([
    tailored ? sign(draft.tailoredCv.pdfKey) : deps.originalCvUrl ? deps.originalCvUrl(orderId, order) : null,
    sign(draft.coverLetterPdfKey),
  ]);
  const extension = tailored ? 'pdf' : (/\.([a-z0-9]{2,5})$/i.exec(originalKey)?.[1] || 'pdf').toLowerCase();
  // The requested documents the candidate gave, each file a signed link too.
  const extra = await Promise.all(extraDocumentsToSend(draft, flow, orderId).map(async (document) => ({
    ...document,
    files: (await Promise.all(document.files.map(async (file) => ({ url: await sign(file.key), detectedType: file.detectedType })))).filter((file) => file.url),
  })));
  return buildFillKit({
    orderId,
    order,
    draft,
    flow,
    documents: { cv: cvUrl ? { url: cvUrl, extension } : null, coverLetter: letterUrl ? { url: letterUrl } : null, extra },
  });
}
