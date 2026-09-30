/**
 * Owner-queue side of the automated assisted application: what Valerie sees
 * (state, clocks, why the flow is held, the full draft with the operator
 * analysis) and what she can do (start, approve — acknowledging warnings —,
 * take over, resume, regenerate, edit the texts, answer on the candidate's
 * behalf). Called by assistedApplicationAdminCore.js behind the verified
 * owner gate.
 */

import { buildCoverLetterPdf } from './assistedApplicationAiDocuments.js';
import {
  candidateIdentity,
  checkDraftFacts,
  clean,
  cleanBlock,
  letterPdfBlocks,
  letterText,
  parseLetterText,
} from './assistedApplicationAiDraftCore.js';
import { isPlausibleEmail } from './assistedApplicationAiJob.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { PORTAL_ACCOUNTS_DOC_ID } from './assistedApplicationConstants.js';
import {
  AUTOMATION_SUBCOLLECTION,
  applyAutomationEvent,
  isAutomationEnabled,
  draftRefFor,
  flowRefFor,
  orderRefFor,
  startAutomation,
} from './assistedApplicationAutomation.js';
import { decryptJson, runKeyFrom } from './lib/evidenceCrypto.js';

export const AUTOMATION_ADMIN_ACTIONS = new Set([
  'automationStart',
  'automationApprove',
  'automationTakeover',
  'automationResume',
  'automationRegenerate',
  'automationEditDraft',
  'automationSetAnswers',
  'automationRevealAccount',
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
  const [flowSnapshot, draftSnapshot, inboxSnapshot, accountsSnapshot] = await Promise.all([
    flowRefFor(db, orderId).get(),
    draftRefFor(db, orderId).get(),
    // Only the latest ten, from the database: an order may collect many messages.
    orderRefFor(db, orderId).collection('inbox').orderBy('receivedAt', 'desc').limit(10).get(),
    orderRefFor(db, orderId).collection(AUTOMATION_SUBCOLLECTION).doc(PORTAL_ACCOUNTS_DOC_ID).get(),
  ]);
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
  if (!flow && !draft && !inbox.length && !accounts.length) return null;
  const signed = (key) => (key && signUrl && isAssistedApplicationCvKey(orderId, key) ? signUrl(key).catch(() => null) : null);
  const [letterUrl, tailoredCvUrl] = await Promise.all([signed(draft?.coverLetterPdfKey), signed(draft?.tailoredCv?.pdfKey)]);
  return {
    inbox,
    accounts,
    flow: flow ? {
      state: flow.state || null,
      round: Number(flow.round) || 1,
      deadlineAt: flow.deadlineAt || null,
      reminderAt: flow.reminderAt || null,
      heldBy: flow.heldBy || [],
      feedback: flow.feedback || [],
      answers: flow.answers || {},
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
      formAnswers: draft.formAnswers || [],
      factCheck: draft.factCheck || null,
      factCheckAcknowledgedAt: draft.factCheckAcknowledgedAt || null,
      knockOutAcknowledgedAt: draft.knockOutAcknowledgedAt || null,
      editedAt: draft.editedAt || null,
      cvTextMethod: draft.cvTextMethod || null,
      coverLetterUrl: letterUrl,
      ats: draft.ats || null,
      legitimacy: draft.legitimacy || null,
      tailoredCv: draft.tailoredCv ? { status: draft.tailoredCv.status, dropped: draft.tailoredCv.dropped || [], unsupported: draft.tailoredCv.unsupported || [], url: tailoredCvUrl } : null,
      cvChoice: flow?.cvChoice || 'tailored',
    } : null,
  };
}

async function editDraft(db, orderId, raw, adminEmail, { bucket, nowMs }) {
  const orderRef = orderRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const [orderSnapshot, draftSnapshot] = await Promise.all([orderRef.get(), draftRef.get()]);
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
  const factCheck = checkDraftFacts({ coverLetter: text, emailSubject: applicationEmail.subject, emailBody: applicationEmail.body }, draft.factSources || {});

  let coverLetterPdfKey = draft.coverLetterPdfKey;
  if (letterRaw && bucket) {
    const identity = candidateIdentity(order, draft.profile);
    const pdf = buildCoverLetterPdf(letterPdfBlocks({
      identity,
      profile: draft.profile,
      posting: { contactPerson: draft.contactPerson || '' },
      companyName: order.companyName,
      language: draft.language || 'it',
      letter: coverLetter,
      title: draft.job?.title || order.jobTitle || '',
      now: new Date(nowMs),
    }));
    coverLetterPdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${draft.round || 1}-edit-${nowMs}.pdf`;
    await bucket.file(coverLetterPdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });
  }
  await draftRef.set({
    coverLetter: { ...coverLetter, text, subject: draft.coverLetter?.subject || '' },
    applicationEmail,
    channel,
    factCheck: { ...factCheck, basis: draft.factCheck?.basis || null },
    // An edit is a new text: a previous acknowledgement does not cover it.
    factCheckAcknowledgedAt: factCheck.ok ? draft.factCheckAcknowledgedAt || null : null,
    coverLetterPdfKey,
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
      if (!(await (deps.isEnabled || isAutomationEnabled)())) throw new AutomationAdminError('automation_disabled', 409);
      const result = await startAutomation({ db, orderId, runEffect: deps.runEffect, nowMs, reason: 'owner_request' });
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
    default:
      throw new AutomationAdminError('invalid_input');
  }
}
