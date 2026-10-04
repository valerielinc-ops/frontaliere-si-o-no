#!/usr/bin/env node
/**
 * Assisted-application agent — entry point of
 * .github/workflows/assisted-application-agent.yml.
 *
 *   node scripts/assisted-application/agent.mjs --order <id> --mode draft|submit --round <n>
 *
 * The run is dispatched by the Cloud Functions (assistedApplicationAutomation.js)
 * with the order id only. It reads everything else from Firestore/Storage,
 * masks every personal value before use, and reports back by adding one
 * document to `assisted_applications/{id}/automation_events`, which a
 * Firestore trigger applies to the flow. Stdout and the step summary carry
 * states and codes only: this repository is public.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ASSISTED_APPLICATION_STORAGE_BUCKET, detectCvFileType } from '../../functions/src/assistedApplicationCvCheck.js';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { buildDraft, DraftAbort } from './lib/draft.mjs';
import { maskValues, personalValuesOf, runKeyFrom } from './lib/secure-run.mjs';
import { portalAccountStore } from './lib/portal/account.mjs';
import { portalKnowledgeStore } from './lib/portal/knowledge.mjs';
import { candidateValues, redactStopReport } from './lib/portal/stop-report.mjs';
import { readPortalQuestions } from './lib/portal/portal.mjs';
import { scheduleFollowups } from '../../functions/src/assistedApplicationFollowup.js';
import { submitApplication } from './lib/submit.mjs';
import { submissionGuard } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import { supersededPhotoPdf } from '../../functions/src/assistedApplicationTailoredCvPdf.js';
import { factCheckTokens } from '../../functions/src/assistedApplicationFlow.js';

const BUCKET = ASSISTED_APPLICATION_STORAGE_BUCKET;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
// dry_run: the submission without the final click, for the owner's tests.
const MODES = new Set(['draft', 'submit', 'dry_run']);
const DRAFT_STATES = new Set(['drafting', 'regenerating']);

function summary(line) {
  console.log(`[assisted-application] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/**
 * A submit the fact gate stopped carries the gate's result of today
 * (lib/submit.mjs). It is taken out of the event, whose tokens quote the
 * candidate's texts, and returned as the draft keeps it: with the basis of the
 * draft's own check. Stored, the owner's panel lists the tokens and the flow
 * holds on them (evaluateRedFlags) until the owner confirms them.
 * @returns {object|null} the patch for ai_drafts/current
 */
export function takeFactCheck(event, draft) {
  if (!event.factCheck) return null;
  const patch = { factCheck: { ...event.factCheck, basis: draft?.factCheck?.basis || null } };
  // An older confirmation, stored without its warnings, covered the result the draft held: those warnings
  // are kept, so the new result's are not taken as confirmed (factCheckAcknowledged).
  if ((draft?.factCheckAcknowledgedAt || draft?.acknowledgedFlags?.fact_check) && !Array.isArray(draft?.factCheckAcknowledgedTokens)) {
    patch.factCheckAcknowledgedTokens = factCheckTokens(draft?.factCheck);
  }
  delete event.factCheck;
  return patch;
}

/** Error text safe for a public log: no addresses, no long free text. */
export function safeErrorCode(error) {
  const raw = error instanceof Error ? (error.code || error.message) : String(error);
  return String(raw)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\+?\d[\d\s/.-]{6,}\d/g, '<number>')
    .replace(/[^A-Za-z0-9_:.<> -]/g, '_')
    .slice(0, 120);
}

/**
 * What left with the application (lib/submit.mjs `sent`: how it was packaged and why, the files with
 * their names and keys), on the draft for the owner's panel and the candidate's page, before the event
 * moves the flow to `submitted`; the record of the attempt (`sentAttempt`) gives way to it. Never in the
 * automation event or the log: the file names carry the candidate's name. A dry run keeps nothing. A
 * write that fails never turns a sent application into a failure: the submission guard and the
 * encrypted evidence hold the same record.
 */
export async function keepSentRecord(event, { draftRef, dryRun }) {
  if (!event?.sent) return;
  const { sent } = event;
  delete event.sent;
  if (dryRun) return;
  try {
    await draftRef.set({ sent, sentAttempt: null }, { merge: true });
  } catch (error) {
    summary(`sent record not kept on the draft: ${safeErrorCode(error)}`);
  }
}

/**
 * The run's draft, written whole in place of the previous one. The previous
 * tailored CV, when it carried the candidate's photo, is then named by no
 * document and is deleted at once (best effort: the purge of the order's
 * folder is the backstop), so a photo taken back in a later round is in no
 * PDF left behind.
 */
export async function writeDraft({ orderRef, bucket, draft, previousDraft }) {
  await orderRef.collection('ai_drafts').doc('current').set(draft);
  const superseded = supersededPhotoPdf(previousDraft);
  if (!superseded || superseded === draft.tailoredCv?.pdfKey) return;
  try {
    await bucket.file(superseded).delete({ ignoreNotFound: true });
  } catch (error) {
    summary(`superseded tailored cv not deleted: ${safeErrorCode(error)}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: { order: { type: 'string' }, mode: { type: 'string' }, round: { type: 'string' } },
  });
  const orderId = String(values.order || '');
  const mode = String(values.mode || '');
  const round = Number(values.round || '1');
  if (!ORDER_ID_RE.test(orderId) || !MODES.has(mode) || !Number.isInteger(round) || round < 1 || round > 20) {
    throw new Error('invalid_arguments');
  }

  const db = await getFirestoreDb();
  const { getStorage } = await import('firebase-admin/storage');
  const bucket = getStorage().bucket(BUCKET);
  const orderRef = db.collection('assisted_applications').doc(orderId);
  const [orderSnapshot, flowSnapshot, draftSnapshot, intakeSnapshot] = await Promise.all([
    orderRef.get(),
    orderRef.collection('automation').doc('flow').get(),
    orderRef.collection('ai_drafts').doc('current').get(),
    orderRef.collection('automation').doc('intake').get(),
  ]);
  if (!orderSnapshot.exists || !flowSnapshot.exists) {
    summary(`mode=${mode} skipped: no order or no flow`);
    return;
  }
  const order = orderSnapshot.data() || {};
  const flow = flowSnapshot.data() || {};
  const previousDraft = draftSnapshot.exists ? draftSnapshot.data() || null : null;
  // With what the candidate typed on the review page (a new phone, a new name...).
  maskValues([personalValuesOf(order, previousDraft?.profile || {}), Object.values(flow.formOverrides || {})]);

  // A run that no longer matches the flow (superseded round, state moved on)
  // must not write anything.
  if (Number(flow.round || 1) !== round
    || (mode === 'draft' && !DRAFT_STATES.has(flow.state))
    || (mode === 'submit' && flow.state !== 'submitting')) {
    summary(`mode=${mode} round=${round} skipped: flow is ${flow.state} round ${flow.round}`);
    return;
  }

  const runKey = runKeyFrom();
  const events = orderRef.collection('automation_events');
  const dryRun = mode === 'dry_run';
  const report = async (event) => {
    // A dry run writes no event: whatever it finds (a closed ad, a question
    // for the candidate) must not move the flow, and the watchdog never sees it.
    if (!dryRun) await events.add({ ...event, round, mode, createdAt: Date.now(), runId: process.env.GITHUB_RUN_ID || null });
    summary(`mode=${mode} round=${round} event=${event.type}${event.error ? ` error=${event.error}` : ''}${event.channel ? ` channel=${event.channel}` : ''}`);
  };

  let cvBuffer;
  let cvType;
  try {
    [cvBuffer] = await bucket.file(order.cvStorageKey).download();
    cvType = detectCvFileType(cvBuffer.subarray(0, 8));
    if (!cvType) throw new Error('cv_type_unknown');
  } catch (error) {
    await report({ type: mode === 'draft' ? 'draft_failed' : 'submit_failed', error: `cv_unavailable:${safeErrorCode(error)}` });
    return;
  }

  if (mode === 'draft') {
    const { requestCodexBrokerJson } = await import('../lib/ai-models.mjs');
    const started = Date.now();
    try {
      const draft = await buildDraft({
        order, orderId, flow, previousDraft, cvBuffer, cvType, bucket, runKey,
        intake: intakeSnapshot.exists ? intakeSnapshot.data() : null,
        codex: (request) => requestCodexBrokerJson(request),
        // A single-page portal form read ahead: its questions reach the first review.
        readPortalQuestions,
      });
      await writeDraft({ orderRef, bucket, draft, previousDraft });
      summary(`draft ready in ${Math.round((Date.now() - started) / 1000)}s: verdict=${draft.verdict} channel=${draft.channel?.type} questions=${draft.questions.length} factWarnings=${draft.factCheck.unsupported.length}`);
      await report({ type: 'draft_ready' });
    } catch (error) {
      if (error instanceof DraftAbort) await report({ type: error.eventType, error: safeErrorCode(error) });
      else await report({ type: 'draft_failed', error: safeErrorCode(error) });
    }
    return;
  }

  if (!previousDraft || previousDraft.status !== 'ready' || Number(previousDraft.round) !== round) {
    await report({ type: 'submit_failed', error: 'draft_missing_for_round' });
    return;
  }
  try {
    const { sendEmailCascade } = await import('../../functions/src/emailCascade.js');
    const { requestCodexBrokerJson } = await import('../lib/ai-models.mjs');
    const event = await submitApplication({
      order, orderId, flow, draft: previousDraft, cvBuffer, cvType, bucket, runKey, sendCascade: sendEmailCascade,
      dryRun,
      submissionGuard: dryRun ? null : submissionGuard(db, orderId, round),
      codex: process.env.CODEX_AUTH_BROKER_SOCKET ? (request) => requestCodexBrokerJson(request) : null,
      // Portal accounts on the order's alias: passwords masked in the log, encrypted in Firestore.
      accounts: portalAccountStore({ db, orderId, key: runKey, mask: (value) => maskValues([value]) }),
      // What each portal taught earlier confirmed submissions (self-correction, level 2).
      knowledge: portalKnowledgeStore({ db }),
      // The record of a send whose outcome may stay unknown, on the draft before the send (null: it failed
      // for certain). A dry run sends nothing.
      keepSentAttempt: dryRun ? null : (sentAttempt) => orderRef.collection('ai_drafts').doc('current').set({ sentAttempt }, { merge: true }),
    });
    // An application sent by e-mail gets its follow-ups (day 7 and 14); the
    // recipient and subject stay in Firestore, not in the automation event.
    if (event.followup && !dryRun) {
      await scheduleFollowups(db, orderId, event.followup);
      delete event.followup;
    }
    // A WhatsApp application: its link goes on the order, for the candidate's
    // «inviata» e-mail with the steps (assistedApplicationNotifications.js).
    if (event.whatsappUrl) {
      if (!dryRun) await orderRef.set({ submissionChannel: 'whatsapp', whatsappApplyUrl: String(event.whatsappUrl).slice(0, 1000) }, { merge: true });
      delete event.whatsappUrl;
    }
    // What the portal received (career-ops application-answers), next to the
    // draft for the interview prep and Valerie's panel; never in the event or the log.
    if (event.portalAnswers) {
      if (!dryRun && event.portalAnswers.answers.length) await orderRef.collection('ai_drafts').doc('current').set({ portalAnswers: event.portalAnswers }, { merge: true });
      delete event.portalAnswers;
    }
    // Where the runner stopped (self-correction, level 3): stripped of every
    // value of the candidate, for the workflow's fix-issue step; never in the event.
    if (event.stopReport) {
      const file = process.env.ASSISTED_APPLICATION_STOP_REPORT;
      if (file) {
        const values = candidateValues([
          personalValuesOf(order, previousDraft?.profile || {}),
          Object.values(flow.answers || {}),
          Object.values(flow.formOverrides || {}),
          order.candidateAlias?.address || '',
        ]);
        writeFileSync(file, JSON.stringify(redactStopReport(event.stopReport, values)));
      }
      delete event.stopReport;
    }
    // The fact gate's result of a stopped submit, next to the draft before the
    // event moves the flow; never in the event or the log.
    const factCheckPatch = takeFactCheck(event, previousDraft);
    if (factCheckPatch && !dryRun) await orderRef.collection('ai_drafts').doc('current').set(factCheckPatch, { merge: true });
    // Questions a portal asked become part of the draft, so the review page
    // shows them and the flow waits for the answers.
    if (!dryRun && event.type === 'submit_needs_candidate' && Array.isArray(event.questions) && event.questions.some((question) => question.question)) {
      const known = new Set((previousDraft.questions || []).map((question) => question.id));
      const added = event.questions.filter((question) => !known.has(question.id));
      await orderRef.collection('ai_drafts').doc('current').set({ questions: [...(previousDraft.questions || []), ...added] }, { merge: true });
      event.questions = event.questions.map((question) => ({ id: question.id }));
    }
    // What left (lib/submit.mjs), on the draft before the event marks the order sent: whatever the
    // event sets off (the candidate's «inviata» e-mail, the review page) finds it there.
    await keepSentRecord(event, { draftRef: orderRef.collection('ai_drafts').doc('current'), dryRun });
    await report(event);
  } catch (error) {
    await report({ type: 'submit_failed', error: safeErrorCode(error) });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((error) => {
  console.error('[assisted-application] fatal', safeErrorCode(error));
  process.exitCode = 1;
});
