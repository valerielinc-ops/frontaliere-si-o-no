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
  checkDraftTexts,
  safeFileStem,
} from '../../../functions/src/assistedApplicationAiDraftCore.js';
import { rebuildLetterPdf } from '../../../functions/src/assistedApplicationLetterPdf.js';
import { cvChoiceOf } from '../../../functions/src/assistedApplicationDocxInPlace.js';
import { candidateWithEdits, formAnswersWithEdits } from '../../../functions/src/assistedApplicationCandidateEdits.js';
import { isPlausibleEmail, resolveApplyUrl } from '../../../functions/src/assistedApplicationAiJob.js';
import { extraDocumentFileName, extraDocumentsToSend, openRequiredDocuments } from '../../../functions/src/assistedApplicationExtraDocuments.js';
import { EMPLOYER_MAIL_FROM, senderName, textToHtml } from '../../../functions/src/assistedApplicationEmployerMail.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidateForForm, submitViaPortal, WAVE1_CHANNELS } from './portal/portal.mjs';
import { checkPostingLiveness } from './posting-liveness.mjs';
import { storeEvidence } from './secure-run.mjs';
import { dossierAttachment, dossierMode, draftCandidateType, wantsDossier } from './dossier.mjs';

const OWNER_MAILBOX = EMPLOYER_MAIL_FROM;
const EXTENSION = { pdf: 'pdf', docx: 'docx', doc: 'doc' };

/** Open required questions block the submission, whatever the channel. */
export function openRequiredQuestions(draft, answers = {}) {
  return (draft?.questions || []).filter((question) => question.required && !String(answers?.[question.id] ?? '').trim());
}

/**
 * @param {object} ctx
 * @returns {Promise<{type:string, channel?:string, reason?:string, error?:string, questions?:Array}>}
 */
/**
 * The CV that leaves: the tailored ATS CV when it passed the fact gate and the
 * candidate did not choose their original on the review page; their own Word
 * file with the adapted lines when they chose it (phase 5).
 */
export async function chooseCv({ draft, flow, bucket, cvBuffer, cvType }) {
  const tailored = draft?.tailoredCv;
  const choice = cvChoiceOf(draft, flow);
  if (tailored?.status === 'ready' && choice === 'inplace') {
    const [buffer] = await bucket.file(tailored.inplace.docxKey).download();
    return { cvBuffer: Buffer.from(buffer), cvType: 'docx', cvSent: 'inplace' };
  }
  if (tailored?.status === 'ready' && tailored.pdfKey && choice !== 'original') {
    const [buffer] = await bucket.file(tailored.pdfKey).download();
    return { cvBuffer: Buffer.from(buffer), cvType: 'pdf', cvSent: 'tailored' };
  }
  return { cvBuffer, cvType, cvSent: 'original' };
}

/**
 * The documents the posting requires besides the CV and the letter, as the
 * candidate gave them on the review page (flow.documents), downloaded and named.
 * @returns {Promise<Array<{slot:string, label:string, kind:string, files:Array<{fileName:string, buffer:Buffer}>}>>}
 */
export async function downloadExtraDocuments({ bucket, draft, flow, orderId, name }) {
  const out = [];
  for (const document of extraDocumentsToSend(draft, flow, orderId)) {
    const files = [];
    for (const [index, file] of document.files.entries()) {
      const [buffer] = await bucket.file(file.key).download();
      files.push({ fileName: extraDocumentFileName({ label: document.label, index, count: document.files.length, name, type: file.detectedType }), buffer: Buffer.from(buffer) });
    }
    out.push({ slot: document.slot, label: document.label, kind: document.kind, files });
  }
  return out;
}

/**
 * The letter that leaves: rebuilt today with the enclosures that really leave
 * with it (the required documents and those the candidate gave). A draft from
 * before the recipient's address was kept on it (no `letterAddress`) sends its
 * stored PDF, so its address is not lost.
 */
export async function letterForSubmission({ bucket, order, orderId, draft, flow, nowMs }) {
  if (draft?.letterAddress) return (await rebuildLetterPdf({ order, orderId, draft, flow, nowMs })).pdf;
  const [stored] = await bucket.file(draft.coverLetterPdfKey).download();
  return Buffer.from(stored);
}

export async function submitApplication(ctx) {
  const { order, orderId, flow, draft, bucket, runKey, sendCascade } = ctx;
  const { cvBuffer, cvType, cvSent } = await chooseCv({ draft, flow, bucket, cvBuffer: ctx.cvBuffer, cvType: ctx.cvType });
  const nowMs = ctx.nowMs || Date.now();
  const answers = flow?.answers || {};
  const log = ctx.log || ((...args) => console.log('[assisted-application]', ...args));

  const liveness = await checkPostingLiveness({
    order,
    // The posting's own page when the channel is the ATS behind it (Coop:
    // SuccessFactors' sign-in says nothing about the posting being open).
    posting: { applyUrl: draft?.channel?.postingUrl || draft?.channel?.applyUrl || draft?.job?.applyUrl },
    fetchImpl: ctx.fetchImpl || fetch,
    resolve: ctx.resolve,
  });
  log('liveness before submit', liveness.page?.result, liveness.page?.code);
  if (liveness.closed) return { type: 'posting_closed', reason: liveness.page?.code || 'dataset' };

  const open = openRequiredQuestions(draft, answers);
  const missingDocuments = openRequiredDocuments(draft, flow?.documents || {});
  if (open.length || missingDocuments.length) {
    return { type: 'submit_needs_candidate', questions: open.map((question) => ({ id: question.id })), documents: missingDocuments };
  }

  const facts = checkDraftTexts({
    coverLetter: draft.coverLetter?.text,
    emailSubject: draft.applicationEmail?.subject,
    emailBody: draft.applicationEmail?.body,
  }, draft.factSources || {}, { language: draft.language });
  if (!facts.ok && !draft.factCheckAcknowledgedAt) return { type: 'submit_failed', error: 'fact_check_not_acknowledged' };

  const channel = draft.channel || {};
  const to = String(draft.applicationEmail?.to || channel.email || '').trim().toLowerCase();
  if (channel.type === 'email' && isPlausibleEmail(to) && to !== OWNER_MAILBOX) {
    const { identity } = candidateWithEdits({ order, draft, flow });
    const letterPdf = await letterForSubmission({ bucket, order, orderId, draft, flow, nowMs });
    const stem = safeFileStem(identity.name);
    const letterLabel = safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it);
    const extras = await downloadExtraDocuments({ bucket, draft, flow, orderId, name: identity.name });
    let attachments = [
      { filename: `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`, content: cvBuffer.toString('base64') },
      { filename: `${letterLabel}_${stem}.pdf`, content: Buffer.from(letterPdf).toString('base64') },
      ...extras.flatMap((document) => document.files.map((file) => ({ filename: file.fileName, content: file.buffer.toString('base64') }))),
    ];
    // One "Bewerbungsdossier" when the Remote Config switch asks for it (SECO: one document,
    // 5 pages, 2 MB); the separate files whenever it cannot be built within those limits.
    if (wantsDossier({ mode: dossierMode(), channelType: 'email', candidateType: draftCandidateType(draft) })) {
      const dossier = await dossierAttachment({ language: draft.language, stem, letter: Buffer.from(letterPdf), cv: { buffer: cvBuffer, type: cvType }, extras });
      if (dossier) attachments = [{ filename: dossier.filename, content: dossier.content }];
      log('dossier', dossier ? `${dossier.pages} pages` : 'separate files (limits or a part not mergeable)');
    }
    if (ctx.dryRun) {
      // A dry run shows what would leave (encrypted, next to the order) and sends nothing.
      await storeEvidence({
        bucket, orderId, name: 'dry-run-email',
        payload: { to, subject: draft.applicationEmail?.subject || '', body: draft.applicationEmail?.body || '', attachments: attachments.map((item) => item.filename), cvSent },
        key: runKey, nowMs,
      });
      return { type: 'dry_run_ready', channel: 'email' };
    }
    // Our own Message-ID, so the follow-ups can refer to this e-mail
    // (best effort: a provider may replace it; the "Re:" subject threads anyway).
    const messageId = `<aa-${String(orderId).replace(/[^A-Za-z0-9_-]/g, '')}-${nowMs}@candidature.frontaliereticino.ch>`;
    const payload = {
      from: `${senderName(identity.name)} <${OWNER_MAILBOX}>`,
      to: [to],
      subject: draft.applicationEmail.subject,
      text: draft.applicationEmail.body,
      html: textToHtml(draft.applicationEmail.body),
      ...(identity.email ? { replyTo: identity.email } : {}),
      headers: { 'Message-ID': messageId },
      attachments,
      // Sent in the candidate's name: no link rewriting and no open pixel.
      tracking: false,
      openTracking: false,
    };
    // Durable idempotency per order and round (submission guard): a run the
    // watchdog re-dispatched never sends the application a second time.
    const guard = ctx.submissionGuard || null;
    if (guard) {
      const claim = await guard.claim('email', nowMs);
      if (claim.status === 'already_sent') {
        // Sent by an earlier run of this round: its follow-ups come from the record.
        const record = claim.record || {};
        return { type: 'submit_succeeded', channel: 'email', replayed: true, ...(record.to ? { followup: { to: record.to, subject: record.subject || '', messageId: record.messageId || '', sentAt: record.sentAt || nowMs } } : {}) };
      }
      if (claim.status === 'in_flight') return { type: 'submit_failed', error: 'email_ambiguous' };
    }
    const { failed, sent } = await sendCascade(
      [{ payload, recipient: { email: to }, meta: { orderId: String(orderId), key: 'employer_application' } }],
      { delayMs: 0, forceProvider: 'resend' },
    );
    if (failed.length) {
      // An ambiguous delivery must never be retried blindly (career-ops: a
      // submit of unknown outcome is not re-submitted): the guard stays
      // "sending", so a later run reports it ambiguous too.
      const ambiguous = Boolean(failed[0].ambiguousDelivery);
      if (guard && !ambiguous) await guard.release('email_failed', nowMs);
      await storeEvidence({ bucket, orderId, name: 'submit-email-failed', payload: { to, subject: payload.subject, error: String(failed[0].error || '').slice(0, 200), ambiguous }, key: runKey, nowMs });
      return { type: 'submit_failed', error: ambiguous ? 'email_ambiguous' : 'email_failed' };
    }
    if (guard) await guard.markSent({ channel: 'email', to, subject: payload.subject, messageId, provider: sent[0]?.provider || null }, nowMs);
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
        cvSent,
        provider: sent[0]?.provider || null,
        messageId: sent[0]?.messageId || null,
        sentAt: nowMs,
      },
      key: runKey,
      nowMs,
    });
    // What the follow-ups (7 and 14 days) need; agent.mjs stores it, it never
    // reaches the automation event.
    return { type: 'submit_succeeded', channel: 'email', followup: { to, subject: payload.subject, messageId, sentAt: nowMs } };
  }

  // Portal, wave 1 (no account): the runner fills and submits; CAPTCHA, login
  // or anything it must not bypass ends in the career-ops handoff below.
  let applyUrl = channel.applyUrl || draft.job?.applyUrl || '';
  // A draft from before the ATS redirect was resolved (Coop's first order,
  // 2026-10-02): the runner starts on the ATS, not on the career page in front of it.
  if (channel.type === 'employer_site' && !channel.via && applyUrl && ctx.codex) {
    applyUrl = (await resolveApplyUrl(applyUrl, { fetchImpl: ctx.fetchImpl || fetch, resolve: ctx.resolve })).applyUrl;
  }
  if (WAVE1_CHANNELS.has(channel.type) && applyUrl && ctx.codex) {
    // The same durable guard as the e-mail: a re-dispatched run never submits
    // twice. A run that died before the final click may start again.
    const guard = ctx.dryRun ? null : ctx.submissionGuard || null;
    if (guard) {
      const claim = await guard.claim('portal', nowMs, { resumable: true });
      if (claim.status === 'already_sent') return { type: 'submit_succeeded', channel: channel.type, replayed: true };
      if (claim.status === 'in_flight') return { type: 'submit_failed', error: 'portal_ambiguous' };
    }
    // With the candidate's corrections from the review page.
    const edited = candidateWithEdits({ order, draft, flow });
    const { identity } = edited;
    let dir = null;
    // Set once `clickedAt` is on record, right before the final click.
    let clicked = false;
    let succeeded = false;
    try {
      dir = await mkdtemp(path.join(tmpdir(), 'aa-portal-'));
      const letterPdf = await letterForSubmission({ bucket, order, orderId, draft, flow, nowMs });
      const stem = safeFileStem(identity.name);
      const files = {
        cv: path.join(dir, `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`),
        cover_letter: path.join(dir, `${safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it)}_${stem}.pdf`),
      };
      await writeFile(files.cv, cvBuffer);
      await writeFile(files.cover_letter, Buffer.from(letterPdf));
      // The requested documents: one slot each (extra_1…), all its files.
      const extras = await downloadExtraDocuments({ bucket, draft, flow, orderId, name: identity.name });
      for (const document of extras) {
        files[document.slot] = [];
        for (const file of document.files) {
          const target = path.join(dir, file.fileName);
          await writeFile(target, file.buffer);
          files[document.slot].push(target);
        }
      }
      const portalQuestions = (draft.questions || []).filter((question) => question.source === 'portal');
      const { event, evidence } = await (ctx.portalRunner || submitViaPortal)({
        applyUrl,
        // The form must be this posting's; Valerie's retry, after she looked at it, goes on.
        job: { title: draft.job?.title || order.jobTitle || '', company: order.companyName || '' },
        skipPostingCheck: flow?.dispatch?.reason === 'owner_retry',
        language: draft.language,
        candidateLocale: draft.candidateLocale || order.locale || 'it',
        candidate: candidateForForm({ identity, profile: edited.profile, answers: edited.answers, draft, portalQuestions, extraDocuments: extras }),
        files,
        codex: ctx.codex,
        accounts: ctx.accounts || null,
        // What each portal taught earlier confirmed submissions (knowledge.mjs).
        knowledge: ctx.knowledge || null,
        log,
        dryRun: Boolean(ctx.dryRun),
        onBeforeSubmit: guard ? async () => { await guard.markClicked(Date.now()); clicked = true; } : null,
      });
      succeeded = event.type === 'submit_succeeded';
      if (guard) {
        // Sent: on record. After the final click any other outcome (ambiguous,
        // a CAPTCHA or an error page that appeared afterwards) is left
        // "sending": the portal may have the application, so it is never
        // re-submitted. Before the click nothing was sent: released. So too when
        // the portal said, on the same page, that it did not send (portal_refused,
        // JOIN «Non siamo riusciti a inviare…»): Valerie's retry may claim it again.
        if (event.type === 'submit_succeeded') await guard.markSent({ channel: channel.type, finalUrl: evidence.finalUrl || null });
        else if (event.type === 'submit_failed' && event.error === 'portal_refused') await guard.release('portal_refused');
        else if (!clicked && !(event.type === 'submit_failed' && /_ambiguous$/.test(event.error || ''))) await guard.release(event.error || event.reason || event.type);
      }
      await storeEvidence({ bucket, orderId, name: `submit-portal-${event.type}`, payload: { applyUrl, event, evidence, cvSent }, key: runKey, nowMs });
      // What went into the form, for the interview prep and for Valerie: agent.mjs
      // stores it with the draft, it never reaches the automation event.
      const portalAnswers = { status: event.type, at: nowMs, answers: evidence.answers || [] };
      // Where the runner stopped, for the fix issue (agent.mjs strikes the candidate's values out first).
      const stopReport = evidence.stopReport ? { stopReport: { ...evidence.stopReport, channel: channel.type } } : {};
      return event.type === 'submit_succeeded' ? { ...event, channel: channel.type, portalAnswers } : { ...event, portalAnswers, ...stopReport };
    } catch (error) {
      // Failed before the final click (temp dir, files, browser, network): nothing
      // reached the employer, so the claim is released for the retry.
      if (guard && !clicked && !succeeded) {
        await guard.release(`error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
      }
      throw error;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  // Account portals (Workday, SuccessFactors, LinkedIn) until wave 2, and any
  // channel without a usable URL: career-ops browser handoff.
  await storeEvidence({
    bucket,
    orderId,
    name: 'submit-handoff',
    payload: { channel, applyUrl: channel.applyUrl || draft.job?.applyUrl || '', formAnswers: formAnswersWithEdits({ order, draft, flow }), answers },
    key: runKey,
    nowMs,
  });
  return { type: 'submit_handoff', reason: channel.requiresAccount ? 'account' : 'portal_needs_candidate' };
}
