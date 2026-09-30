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

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { detectCvFileType } from '../../functions/src/assistedApplicationCvCheck.js';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { buildDraft, DraftAbort } from './lib/draft.mjs';
import { maskValues, personalValuesOf, runKeyFrom } from './lib/secure-run.mjs';
import { submitApplication } from './lib/submit.mjs';

const BUCKET = 'frontaliere-ticino.firebasestorage.app';
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const MODES = new Set(['draft', 'submit']);
const DRAFT_STATES = new Set(['drafting', 'regenerating']);

function summary(line) {
  console.log(`[assisted-application] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
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
  const [orderSnapshot, flowSnapshot, draftSnapshot] = await Promise.all([
    orderRef.get(),
    orderRef.collection('automation').doc('flow').get(),
    orderRef.collection('ai_drafts').doc('current').get(),
  ]);
  if (!orderSnapshot.exists || !flowSnapshot.exists) {
    summary(`mode=${mode} skipped: no order or no flow`);
    return;
  }
  const order = orderSnapshot.data() || {};
  const flow = flowSnapshot.data() || {};
  const previousDraft = draftSnapshot.exists ? draftSnapshot.data() || null : null;
  maskValues(personalValuesOf(order, previousDraft?.profile || {}));

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
  const report = async (event) => {
    await events.add({ ...event, round, mode, createdAt: Date.now(), runId: process.env.GITHUB_RUN_ID || null });
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
        codex: (request) => requestCodexBrokerJson(request),
      });
      await orderRef.collection('ai_drafts').doc('current').set(draft);
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
    const event = await submitApplication({
      order, orderId, flow, draft: previousDraft, cvBuffer, cvType, bucket, runKey, sendCascade: sendEmailCascade,
    });
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
