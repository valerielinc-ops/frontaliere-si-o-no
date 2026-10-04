/**
 * Submit mode of the assisted-application agent (GitHub Actions).
 *
 *   liveness gate (career-ops: re-check right before applying)
 *   → e-mail channel: send the application to the address the posting gives,
 *     CV and cover letter attached, replies going straight to the candidate,
 *     packaged as dossier.mjs decides (the CV and the letter apart by default,
 *     the requested documents grouped, one PDF when the ad or the switch asks)
 *   → portal channel: until the portal runner covers it, career-ops'
 *     "browser handoff" — the candidate gets the direct link, the numbered
 *     answers and the documents, and confirms once submitted.
 * Returns the event for the Cloud Functions and stores encrypted evidence of
 * exactly what left in the candidate's name. The run keeps next to the order
 * the files that were not in Storage yet and returns the record of what left
 * (`sent`, kept on the draft by agent.mjs, never in the event); the record of
 * a send about to start goes on the draft first (`sentAttempt`), so an
 * uncertain outcome keeps it until the send is confirmed.
 */

import {
  LETTER_FILE_LABEL,
  checkDraftTexts,
  safeFileStem,
} from '../../../functions/src/assistedApplicationAiDraftCore.js';
import { rebuildLetterPdf } from '../../../functions/src/assistedApplicationLetterPdf.js';
import { cvChoiceOf } from '../../../functions/src/assistedApplicationDocxInPlace.js';
import { candidateWithEdits, formAnswersWithEdits } from '../../../functions/src/assistedApplicationCandidateEdits.js';
import { classifyApplicationChannel, isPlausibleEmail, resolveApplyUrl } from '../../../functions/src/assistedApplicationAiJob.js';
import { extraDocumentFileName, extraDocumentsToSend, openRequiredDocuments } from '../../../functions/src/assistedApplicationExtraDocuments.js';
import { EMPLOYER_MAIL_FROM, senderName, textToHtml } from '../../../functions/src/assistedApplicationEmployerMail.js';
import { factCheckAcknowledged } from '../../../functions/src/assistedApplicationFlow.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidateForForm, submitViaPortal, WAVE1_CHANNELS } from './portal/portal.mjs';
import { checkPostingLiveness } from './posting-liveness.mjs';
import { storeEvidence } from './secure-run.mjs';
import { adPackaging, dossierMode, draftCandidateType, packageAttachments } from './dossier.mjs';

const OWNER_MAILBOX = EMPLOYER_MAIL_FROM;
// PastaHR's application page (QR code / «Open WhatsApp»), over https.
const WHATSAPP_APPLICATION_RE = /^https:\/\/([a-z0-9-]+\.)*pastahr\.(com|io)\//i;
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
 * `cvKey`: where the CV that leaves is in Storage (the record of the send names it).
 */
export async function chooseCv({ draft, flow, bucket, cvBuffer, cvType, cvKey = null }) {
  const tailored = draft?.tailoredCv;
  const choice = cvChoiceOf(draft, flow);
  if (tailored?.status === 'ready' && choice === 'inplace') {
    const [buffer] = await bucket.file(tailored.inplace.docxKey).download();
    return { cvBuffer: Buffer.from(buffer), cvType: 'docx', cvSent: 'inplace', cvKey: tailored.inplace.docxKey };
  }
  if (tailored?.status === 'ready' && tailored.pdfKey && choice !== 'original') {
    const [buffer] = await bucket.file(tailored.pdfKey).download();
    return { cvBuffer: Buffer.from(buffer), cvType: 'pdf', cvSent: 'tailored', cvKey: tailored.pdfKey };
  }
  return { cvBuffer, cvType, cvSent: 'original', cvKey };
}

/**
 * The documents the posting requires besides the CV and the letter, as the
 * candidate gave them on the review page (flow.documents), downloaded and named.
 * `type`: the type its bytes were verified as at upload; `key`: where it is in Storage.
 * @returns {Promise<Array<{slot:string, label:string, kind:string, files:Array<{fileName:string, buffer:Buffer, key:string, type:string}>}>>}
 */
export async function downloadExtraDocuments({ bucket, draft, flow, orderId, name }) {
  const out = [];
  for (const document of extraDocumentsToSend(draft, flow, orderId)) {
    const files = [];
    for (const [index, file] of document.files.entries()) {
      const [buffer] = await bucket.file(file.key).download();
      files.push({ fileName: extraDocumentFileName({ label: document.label, index, count: document.files.length, name, type: file.detectedType }), buffer: Buffer.from(buffer), key: file.key, type: file.detectedType });
    }
    out.push({ slot: document.slot, label: document.label, kind: document.kind, files });
  }
  return out;
}

const RENDERERS = new Set(['typst', 'legacy']);
/**
 * The letter that leaves: rebuilt today with the enclosures that really leave
 * with it (the required documents and those the candidate gave). A draft from
 * before the recipient's address was kept on it (no `letterAddress`) sends its
 * stored PDF, so its address is not lost; the draft records the writer of
 * that very file (`coverLetterRenderer`, written with every `coverLetterPdfKey`).
 * @returns {Promise<{pdf:Buffer, renderer:'typst'|'legacy'|null, key:string|null}>} key: where it already is (null when rebuilt)
 */
export async function letterForSubmission({ bucket, order, orderId, draft, flow, nowMs }) {
  if (draft?.letterAddress) {
    const { pdf, renderer } = await rebuildLetterPdf({ order, orderId, draft, flow, nowMs });
    return { pdf: Buffer.from(pdf), renderer, key: null };
  }
  const [stored] = await bucket.file(draft.coverLetterPdfKey).download();
  return { pdf: Buffer.from(stored), renderer: RENDERERS.has(draft.coverLetterRenderer) ? draft.coverLetterRenderer : null, key: draft.coverLetterPdfKey || null };
}

/**
 * The record of what left (`sent`), as the draft, the submission guard and the evidence keep it. Every key
 * is present, null when it does not apply: Firestore stores no undefined, and a merge must not leave an
 * older value. The file names carry the candidate's name: the record never goes into the automation event
 * or the log (agent.mjs keepSentRecord).
 */
export function recordOfSend({ at, channel, packaging, reason = 'default', ad = '', adCue = '', documentsGrouped = false, documentsReason = null, pages = null, bytes = null, letterRenderer = null, letterKey = null, files = [] }) {
  return {
    at, channel, packaging, reason,
    ad: ad === 'single' || ad === 'separate' ? ad : '',
    adCue: String(adCue || '').slice(0, 80),
    documentsGrouped: Boolean(documentsGrouped),
    documentsReason: documentsReason || null,
    pages: pages ?? null,
    bytes: bytes ?? null,
    letterRenderer: RENDERERS.has(letterRenderer) ? letterRenderer : null,
    letterKey: letterKey || null,
    files: files.map(({ kind, name, key }) => ({ kind, name, key: key || null })),
  };
}

// What a send makes that is not in Storage yet: PDFs only (the letter is passed apart).
const NEW_FILE_KINDS = new Set(['dossier', 'documents']);

/**
 * Keeps next to the order the files of this send that are not in Storage yet (the letter rebuilt today,
 * a merged PDF), under flat names with no personal data: the retention deletes the order's folder and
 * accepts no sub-folder. The letter is kept even when it left inside the dossier. The other files keep
 * the key they have.
 * @param {{bucket:any, orderId:string, round:number, nowMs:number, prefix?:string, letter?:{buffer:Buffer, key:string|null}|null,
 *   attachments:Array<{kind:string, name:string, buffer?:Buffer, key?:string|null}>}} input
 * @returns {Promise<{letterKey:string|null, files:Array<{kind:string, name:string, key:string|null}>}>}
 */
export async function keepSentFiles({ bucket, orderId, round, nowMs, prefix = 'sent', letter = null, attachments }) {
  const keep = async (kind, buffer) => {
    const key = `assisted-application-uploads/${orderId}/${prefix}-r${round}-${nowMs}-${kind}.pdf`;
    await bucket.file(key).save(buffer, { contentType: 'application/pdf', resumable: false });
    return key;
  };
  const letterKey = letter ? letter.key || await keep('letter', letter.buffer) : null;
  const files = [];
  for (const item of attachments) {
    const key = item.kind === 'letter' ? letterKey : NEW_FILE_KINDS.has(item.kind) ? await keep(item.kind, item.buffer) : item.key || null;
    files.push({ kind: item.kind, name: item.name, key });
  }
  return { letterKey, files };
}

/** What a portal run put into the form's file fields (portal.mjs `evidence.uploads`): document → how many of its files. */
export function portalUploads(evidence) {
  const out = new Map();
  for (const item of Array.isArray(evidence?.uploads) ? evidence.uploads : []) {
    if (item?.document) out.set(String(item.document), Math.max(out.get(String(item.document)) || 0, Number(item.files) || 1));
  }
  return out;
}

export async function submitApplication(ctx) {
  const { order, orderId, flow, draft, bucket, runKey, sendCascade } = ctx;
  const { cvBuffer, cvType, cvSent, cvKey } = await chooseCv({ draft, flow, bucket, cvBuffer: ctx.cvBuffer, cvType: ctx.cvType, cvKey: order?.cvStorageKey || null });
  const nowMs = ctx.nowMs || Date.now();
  const answers = flow?.answers || {};
  const log = ctx.log || ((...args) => console.log('[assisted-application]', ...args));
  // The record of a send whose outcome may stay unknown, on the draft (agent.mjs: `sentAttempt`), or null
  // once the send failed for certain. It becomes the record of what left when the owner or the employer's
  // e-mail confirms the send (assistedApplicationAutomation.js confirmSentAttempt). Never fails the run.
  const keepAttempt = async (attempt) => {
    if (!ctx.keepSentAttempt) return;
    try {
      await ctx.keepSentAttempt(attempt);
    } catch {
      log('send attempt not kept on the draft');
    }
  };

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
  // The gate of the day may be stricter than the one the draft was written with. Its result travels
  // next to the failure: agent.mjs stores it with the draft, so the owner sees the tokens and can
  // confirm them (the stored result alone would show nothing to confirm); it never reaches the event.
  // The owner's confirmation counts only for the warnings they saw (factCheckAcknowledged): a new one stops the send.
  if (!facts.ok && !factCheckAcknowledged(draft, facts)) return { type: 'submit_failed', error: 'fact_check_not_acknowledged', factCheck: facts };

  const channel = draft.channel || {};
  const to = String(draft.applicationEmail?.to || channel.email || '').trim().toLowerCase();
  if (channel.type === 'email' && isPlausibleEmail(to) && to !== OWNER_MAILBOX) {
    const { identity } = candidateWithEdits({ order, draft, flow });
    const letter = await letterForSubmission({ bucket, order, orderId, draft, flow, nowMs });
    const stem = safeFileStem(identity.name);
    const letterLabel = safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it);
    const extras = await downloadExtraDocuments({ bucket, draft, flow, orderId, name: identity.name });
    // How the files leave (dossier.mjs): the posting's own instruction, then the switch; by
    // default the CV and the letter apart and the requested documents grouped.
    const packaged = await packageAttachments({
      language: draft.language, name: identity.name, stem, ad: adPackaging(draft), nowMs,
      cv: { buffer: cvBuffer, type: cvType, name: `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`, key: cvKey },
      letter: { buffer: letter.pdf, name: `${letterLabel}_${stem}.pdf`, key: letter.key },
      extras, mode: dossierMode(), candidateType: draftCandidateType(draft),
    });
    // Codes and counts only: the file names carry the candidate's name.
    log('attachments', packaged.packaging, packaged.reason, `ad=${packaged.ad || 'none'}`,
      `documents=${packaged.documentsGrouped ? 'grouped' : packaged.documentsReason || packaged.attachments.filter((item) => item.kind === 'document').length}`,
      packaged.pages ? `${packaged.pages} pages ${packaged.bytes} bytes` : '');
    const attachments = packaged.attachments.map((item) => ({ filename: item.name, content: item.buffer.toString('base64') }));
    const keep = (prefix) => keepSentFiles({ bucket, orderId, round: Number(draft.round) || 1, nowMs, prefix, letter: { buffer: letter.pdf, key: letter.key }, attachments: packaged.attachments });
    const recordOf = (kept) => recordOfSend({ ...packaged, ...kept, at: nowMs, channel: 'email', letterRenderer: letter.renderer });
    if (ctx.dryRun) {
      // A dry run shows what would leave (encrypted, next to the order; its files under dry-run-…) and sends nothing.
      const sent = recordOf(await keep('dry-run'));
      await storeEvidence({
        bucket, orderId, name: 'dry-run-email',
        payload: { to, subject: draft.applicationEmail?.subject || '', body: draft.applicationEmail?.body || '', attachments: attachments.map((item) => item.filename), cvSent, sent },
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
    // What leaves is kept next to the order before anything is claimed or sent: no application leaves
    // without the files of its record. Nothing was claimed, nothing left: a later run starts afresh.
    let sentRecord;
    try {
      sentRecord = recordOf(await keep('sent'));
    } catch {
      return { type: 'submit_failed', error: 'sent_files_not_stored' };
    }
    // Durable idempotency per order and round (submission guard): a run the
    // watchdog re-dispatched never sends the application a second time.
    const guard = ctx.submissionGuard || null;
    if (guard) {
      const claim = await guard.claim('email', nowMs);
      if (claim.status === 'already_sent') {
        // Sent by an earlier run of this round: its follow-ups and its record come from the guard.
        const record = claim.record || {};
        return { type: 'submit_succeeded', channel: 'email', replayed: true, ...(record.to ? { followup: { to: record.to, subject: record.subject || '', messageId: record.messageId || '', sentAt: record.sentAt || nowMs } } : {}), ...(record.sent ? { sent: record.sent } : {}) };
      }
      if (claim.status === 'in_flight') return { type: 'submit_failed', error: 'email_ambiguous' };
    }
    // Claimed: from here the outcome may stay unknown, so the record goes on the draft before the send.
    // After the claim, never before: a re-dispatched run that finds the round in flight keeps this one's.
    await keepAttempt(sentRecord);
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
      // Failed for certain: nothing left, the attempt is no record. An ambiguous one keeps it.
      if (!ambiguous) await keepAttempt(null);
      await storeEvidence({ bucket, orderId, name: 'submit-email-failed', payload: { to, subject: payload.subject, error: String(failed[0].error || '').slice(0, 200), ambiguous, sent: sentRecord }, key: runKey, nowMs });
      return { type: 'submit_failed', error: ambiguous ? 'email_ambiguous' : 'email_failed' };
    }
    if (guard) await guard.markSent({ channel: 'email', to, subject: payload.subject, messageId, provider: sent[0]?.provider || null, sent: sentRecord }, nowMs);
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
        sent: sentRecord,
      },
      key: runKey,
      nowMs,
    });
    // What the follow-ups (7 and 14 days) need and the record of what left; agent.mjs
    // stores them, they never reach the automation event.
    return { type: 'submit_succeeded', channel: 'email', followup: { to, subject: payload.subject, messageId, sentAt: nowMs }, sent: sentRecord };
  }

  // Portal, wave 1 (no account): the runner fills and submits; CAPTCHA, login
  // or anything it must not bypass ends in the career-ops handoff below.
  let applyUrl = channel.applyUrl || draft.job?.applyUrl || '';
  let channelType = channel.type;
  // A draft from before the ATS redirect was resolved (Coop's first order,
  // 2026-10-02): the runner starts on the ATS, not on the career page in front of it.
  if (channel.type === 'employer_site' && !channel.via && applyUrl && ctx.codex) {
    const target = await resolveApplyUrl(applyUrl, { fetchImpl: ctx.fetchImpl || fetch, resolve: ctx.resolve });
    if (target.via) {
      applyUrl = target.applyUrl;
      channelType = classifyApplicationChannel({ applyUrl }).type;
    }
  }
  if (WAVE1_CHANNELS.has(channelType) && applyUrl && ctx.codex) {
    // The same durable guard as the e-mail: a re-dispatched run never submits
    // twice. A run that died before the final click may start again.
    const guard = ctx.dryRun ? null : ctx.submissionGuard || null;
    if (guard) {
      const claim = await guard.claim('portal', nowMs, { resumable: true });
      if (claim.status === 'already_sent') return { type: 'submit_succeeded', channel: channelType, replayed: true, ...(claim.record?.sent ? { sent: claim.record.sent } : {}) };
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
      const letter = await letterForSubmission({ bucket, order, orderId, draft, flow, nowMs });
      const stem = safeFileStem(identity.name);
      const files = {
        cv: path.join(dir, `CV_${stem}.${EXTENSION[cvType] || 'pdf'}`),
        cover_letter: path.join(dir, `${safeFileStem(LETTER_FILE_LABEL[draft.language] || LETTER_FILE_LABEL.it)}_${stem}.pdf`),
      };
      await writeFile(files.cv, cvBuffer);
      await writeFile(files.cover_letter, letter.pdf);
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
      // What the form's file fields received (portal.mjs evidence.uploads), kept and recorded as an e-mail's
      // attachments are. Never fails the run: the application may have left.
      const portalRecord = async (uploadList, prefix) => {
        const uploads = portalUploads({ uploads: uploadList });
        const letterLeft = uploads.has('cover_letter') ? { buffer: letter.pdf, key: letter.key } : null;
        const uploaded = [
          ...(uploads.has('cv') ? [{ kind: 'cv', name: path.basename(files.cv), key: cvKey }] : []),
          ...(letterLeft ? [{ kind: 'letter', name: path.basename(files.cover_letter) }] : []),
          ...extras.flatMap((document) => document.files.slice(0, uploads.get(document.slot) || 0)
            .map((file) => ({ kind: 'document', name: file.fileName, key: file.key }))),
        ];
        const kept = await keepSentFiles({ bucket, orderId, round: Number(draft.round) || 1, nowMs, prefix, letter: letterLeft, attachments: uploaded })
          .catch(() => {
            log('sent files not kept');
            return { letterKey: letterLeft?.key || null, files: uploaded.map(({ kind, name, key }) => ({ kind, name, key: key || null })) };
          });
        return recordOfSend({ at: nowMs, channel: channelType, packaging: 'portal', letterRenderer: letterLeft ? letter.renderer : null, ...kept });
      };
      // A round the guard releases sent nothing: the attempt recorded at its final click is no record.
      const release = async (reason) => {
        await guard.release(reason);
        if (clicked) await keepAttempt(null);
      };
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
        onBeforeSubmit: guard ? async (form = {}) => {
          await guard.markClicked(Date.now());
          clicked = true;
          // From here the outcome may stay unknown: what the form holds goes on the draft first. Never fails the click.
          const attempt = await portalRecord(form.uploads, 'sent').catch(() => null);
          if (attempt) await keepAttempt(attempt);
        } : null,
      });
      succeeded = event.type === 'submit_succeeded';
      // A dry run keeps its files under dry-run-… and its record in the evidence only.
      const sentRecord = succeeded || event.type === 'dry_run_ready' ? await portalRecord(evidence.uploads, ctx.dryRun ? 'dry-run' : 'sent') : null;
      if (guard) {
        // Sent: on record. After the final click any other outcome (ambiguous,
        // a CAPTCHA or an error page that appeared afterwards) is left
        // "sending": the portal may have the application, so it is never
        // re-submitted. Before the click nothing was sent: released. So too when
        // the portal said, on the same page, that it did not send (portal_refused,
        // JOIN «Non siamo riusciti a inviare…»): Valerie's retry may claim it again.
        // Every final click answered by the portal's own validation (required
        // fields missing, the form still there: Coop's SuccessFactors
        // 2026-10-03) sent nothing either.
        const refusedByValidation = (evidence.finalOutcomes || []).length > 0 && evidence.finalOutcomes.every((outcome) => outcome === 'validation');
        if (event.type === 'submit_succeeded') await guard.markSent({ channel: channelType, finalUrl: evidence.finalUrl || null, sent: sentRecord });
        else if (event.type === 'submit_failed' && event.error === 'portal_refused') await release('portal_refused');
        else if (refusedByValidation && !(event.type === 'submit_failed' && /_ambiguous$/.test(event.error || ''))) await release('portal_validation');
        else if (!clicked && !(event.type === 'submit_failed' && /_ambiguous$/.test(event.error || ''))) await release(event.error || event.reason || event.type);
      }
      await storeEvidence({ bucket, orderId, name: `submit-portal-${event.type}`, payload: { applyUrl, event, evidence, cvSent, ...(sentRecord ? { sent: sentRecord } : {}) }, key: runKey, nowMs });
      // What went into the form, for the interview prep and for Valerie: agent.mjs
      // stores it with the draft, it never reaches the automation event.
      const portalAnswers = { status: event.type, at: nowMs, answers: evidence.answers || [] };
      // Where the runner stopped, for the fix issue (agent.mjs strikes the candidate's values out first).
      const stopReport = evidence.stopReport ? { stopReport: { ...evidence.stopReport, channel: channelType } } : {};
      return event.type === 'submit_succeeded' ? { ...event, channel: channelType, portalAnswers, sent: sentRecord } : { ...event, portalAnswers, ...stopReport };
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

  // A WhatsApp application (PastaHR: Coop's apprenticeships). Owner decision
  // 2026-10-03: it is done once the candidate has the link and the steps by
  // e-mail, the order's «inviata» message (assistedApplicationNotifications.js).
  // No browser runs and nobody presses anything in the candidate's name.
  if (channelType === 'pastahr' && WHATSAPP_APPLICATION_RE.test(applyUrl)) {
    if (ctx.dryRun) return { type: 'dry_run_ready', channel: 'whatsapp' };
    // No file leaves from us: the candidate sends from their phone.
    const sentRecord = recordOfSend({ at: nowMs, channel: 'whatsapp', packaging: 'whatsapp' });
    await storeEvidence({ bucket, orderId, name: 'submit-whatsapp', payload: { channel, applyUrl, sent: sentRecord }, key: runKey, nowMs });
    return { type: 'submit_succeeded', channel: 'whatsapp', whatsappUrl: applyUrl, sent: sentRecord };
  }

  // LinkedIn, a WhatsApp channel without its link and any channel without a
  // usable URL: career-ops browser handoff.
  await storeEvidence({
    bucket,
    orderId,
    name: 'submit-handoff',
    payload: { channel, applyUrl, formAnswers: formAnswersWithEdits({ order, draft, flow }), answers },
    key: runKey,
    nowMs,
  });
  const reason = channelType === 'pastahr' ? 'whatsapp' : channel.requiresAccount ? 'account' : 'portal_needs_candidate';
  return { type: 'submit_handoff', reason };
}
