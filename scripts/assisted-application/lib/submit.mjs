/**
 * Submit mode of the assisted-application agent (GitHub Actions).
 *
 *   liveness gate (career-ops: re-check right before applying)
 *   → e-mail channel: send the application to the address the posting gives,
 *     CV and cover letter attached, replies going straight to the candidate
 *   → portal channel: until the portal runner covers it, career-ops'
 *     "browser handoff" — the candidate gets the direct link, the numbered
 *     answers and the documents, and confirms once submitted.
 * Returns the event for the Cloud Functions and stores encrypted evidence of
 * exactly what left in the candidate's name.
 */

import {
  LETTER_FILE_LABEL,
  candidateIdentity,
  checkDraftFacts,
  safeFileStem,
} from '../../../functions/src/assistedApplicationAiDraftCore.js';
import { isPlausibleEmail } from '../../../functions/src/assistedApplicationAiJob.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidateForForm, submitViaPortal, WAVE1_CHANNELS } from './portal/portal.mjs';
import { checkPostingLiveness } from './posting-liveness.mjs';
import { storeEvidence } from './secure-run.mjs';

const OWNER_MAILBOX = 'valerie@frontaliereticino.ch';
const EXTENSION = { pdf: 'pdf', docx: 'docx', doc: 'doc' };

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text) {
  return String(text || '').trim().split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function senderName(name) {
  const safe = String(name || '').replace(/["<>\\\r\n]/g, '').trim().slice(0, 80);
  return safe ? `"${safe} via Frontaliere Ticino"` : 'Frontaliere Ticino';
}

/** Open required questions block the submission, whatever the channel. */
export function openRequiredQuestions(draft, answers = {}) {
  return (draft?.questions || []).filter((question) => question.required && !String(answers?.[question.id] ?? '').trim());
}

/**
 * @param {object} ctx
 * @returns {Promise<{type:string, channel?:string, reason?:string, error?:string, questions?:Array}>}
 */
export async function submitApplication(ctx) {
  const { order, orderId, flow, draft, cvBuffer, cvType, bucket, runKey, sendCascade } = ctx;
  const nowMs = ctx.nowMs || Date.now();
  const answers = flow?.answers || {};
  const log = ctx.log || ((...args) => console.log('[assisted-application]', ...args));

  const liveness = await checkPostingLiveness({
    order,
    posting: { applyUrl: draft?.channel?.applyUrl || draft?.job?.applyUrl },
    fetchImpl: ctx.fetchImpl || fetch,
    resolve: ctx.resolve,
  });
  log('liveness before submit', liveness.page?.result, liveness.page?.code);
  if (liveness.closed) return { type: 'posting_closed', reason: liveness.page?.code || 'dataset' };

  const open = openRequiredQuestions(draft, answers);
  if (open.length) return { type: 'submit_needs_candidate', questions: open.map((question) => ({ id: question.id })) };

  const facts = checkDraftFacts({
    coverLetter: draft.coverLetter?.text,
    emailSubject: draft.applicationEmail?.subject,
    emailBody: draft.applicationEmail?.body,
  }, draft.factSources || {});
  if (!facts.ok && !draft.factCheckAcknowledgedAt) return { type: 'submit_failed', error: 'fact_check_not_acknowledged' };

  const channel = draft.channel || {};
  const to = String(draft.applicationEmail?.to || channel.email || '').trim().toLowerCase();
  if (channel.type === 'email' && isPlausibleEmail(to) && to !== OWNER_MAILBOX) {
    const identity = candidateIdentity(order, draft.profile);
    const [letterPdf] = await bucket.file(draft.coverLetterPdfKey).download();
    const stem = safeFileStem(identity.name);
    const letterLabel = safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it);
    const attachments = [
      { filename: `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`, content: cvBuffer.toString('base64') },
      { filename: `${letterLabel}_${stem}.pdf`, content: Buffer.from(letterPdf).toString('base64') },
    ];
    const payload = {
      from: `${senderName(identity.name)} <${OWNER_MAILBOX}>`,
      to: [to],
      subject: draft.applicationEmail.subject,
      text: draft.applicationEmail.body,
      html: textToHtml(draft.applicationEmail.body),
      ...(identity.email ? { replyTo: identity.email } : {}),
      attachments,
      tracking: false,
    };
    const { failed, sent } = await sendCascade(
      [{ payload, recipient: { email: to }, meta: { orderId: String(orderId), key: 'employer_application' } }],
      { delayMs: 0, forceProvider: 'resend' },
    );
    if (failed.length) {
      // An ambiguous delivery must never be retried blindly (career-ops: a
      // submit of unknown outcome is not re-submitted).
      const ambiguous = Boolean(failed[0].ambiguousDelivery);
      await storeEvidence({ bucket, orderId, name: 'submit-email-failed', payload: { to, subject: payload.subject, error: String(failed[0].error || '').slice(0, 200), ambiguous }, key: runKey, nowMs });
      return { type: 'submit_failed', error: ambiguous ? 'email_ambiguous' : 'email_failed' };
    }
    await storeEvidence({
      bucket,
      orderId,
      name: 'submit-email',
      payload: {
        to,
        subject: payload.subject,
        body: payload.text,
        replyTo: payload.replyTo || null,
        attachments: attachments.map((item) => item.filename),
        provider: sent[0]?.provider || null,
        messageId: sent[0]?.messageId || null,
        sentAt: nowMs,
      },
      key: runKey,
      nowMs,
    });
    return { type: 'submit_succeeded', channel: 'email' };
  }

  // Portal, wave 1 (no account): the runner fills and submits; CAPTCHA, login
  // or anything it must not bypass ends in the career-ops handoff below.
  const applyUrl = channel.applyUrl || draft.job?.applyUrl || '';
  if (WAVE1_CHANNELS.has(channel.type) && applyUrl && ctx.codex) {
    const identity = candidateIdentity(order, draft.profile);
    const dir = await mkdtemp(path.join(tmpdir(), 'aa-portal-'));
    try {
      const [letterPdf] = await bucket.file(draft.coverLetterPdfKey).download();
      const stem = safeFileStem(identity.name);
      const files = {
        cv: path.join(dir, `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`),
        cover_letter: path.join(dir, `${safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it)}_${stem}.pdf`),
      };
      await writeFile(files.cv, cvBuffer);
      await writeFile(files.cover_letter, Buffer.from(letterPdf));
      const portalQuestions = (draft.questions || []).filter((question) => question.source === 'portal');
      const { event, evidence } = await (ctx.portalRunner || submitViaPortal)({
        applyUrl,
        language: draft.language,
        candidateLocale: draft.candidateLocale || order.locale || 'it',
        candidate: candidateForForm({ identity, profile: draft.profile, answers, draft, portalQuestions }),
        files,
        codex: ctx.codex,
        log,
        dryRun: Boolean(ctx.dryRun),
      });
      await storeEvidence({ bucket, orderId, name: `submit-portal-${event.type}`, payload: { applyUrl, event, evidence }, key: runKey, nowMs });
      return event.type === 'submit_succeeded' ? { ...event, channel: channel.type } : event;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Account portals (Workday, SuccessFactors, LinkedIn) until wave 2, and any
  // channel without a usable URL: career-ops browser handoff.
  await storeEvidence({
    bucket,
    orderId,
    name: 'submit-handoff',
    payload: { channel, applyUrl: channel.applyUrl || draft.job?.applyUrl || '', formAnswers: draft.formAnswers, answers },
    key: runKey,
    nowMs,
  });
  return { type: 'submit_handoff', reason: channel.requiresAccount ? 'account' : 'portal_needs_candidate' };
}
