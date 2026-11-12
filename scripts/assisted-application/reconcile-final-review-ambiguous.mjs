#!/usr/bin/env node
/** Reconcile only encrypted evidence that proves an ambiguous click stopped at final review. */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { getStorage } from 'firebase-admin/storage';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { ASSISTED_APPLICATION_ORDER_ID_RE } from '../../functions/src/assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { buildAssistedApplicationEvent } from '../../functions/src/assistedApplicationAudit.js';
import { PORTAL_AUTO_RETRY_DELAYS_MS } from '../../functions/src/assistedApplicationPortalRetryPolicy.js';
import { confirmedNotSentRecord } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import { decryptJson, runKeyFrom } from './lib/secure-run.mjs';
import { SUBMIT_RE } from './lib/portal/fill.mjs';
import {
  decideFinalReviewAmbiguousReconciliation,
  PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION as RECOVERY_VERSION,
} from './lib/final-review-ambiguous-reconciliation.mjs';

const execFile = promisify(execFileCallback);
const PAGE_SIZE = 100;
const RUN_KEY_REMOTE_CONFIG_PARAM = 'ASSISTED_APPLICATION_RUN_KEY';
const SWIFT_OCR = `
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do { request.recognitionLanguages = ["en-US", "de-DE", "fr-FR", "it-IT"] } catch { }
let handler = VNImageRequestHandler(url: url, options: [:])
try handler.perform([request])
let rows = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let text = observation.topCandidates(1).first?.string else { return nil }
    return ["text": text, "x": observation.boundingBox.minX, "y": observation.boundingBox.minY,
            "width": observation.boundingBox.width, "height": observation.boundingBox.height]
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
print(String(data: data, encoding: .utf8) ?? "[]")
`;

const OCR_FINAL_CONTROL_LABELS = new Set([
  'submit', 'submit application', 'send application', 'apply', 'apply now', 'confirm and apply',
  'confirm and send', 'confirm and submit', 'absenden', 'abschicken', 'senden', 'bewerben', 'jetzt bewerben',
  'bestätigen und bewerben', 'bestätigen und absenden', 'bestätigen und senden', 'invia candidatura',
  'invia la candidatura', 'invia', 'inviare', 'candidati ora', 'candidati', 'applica',
  'conferma e applica', 'conferma e invia', 'envoyer candidature', 'envoyer ma candidature',
  'envoyer', 'postuler', 'soumettre', 'confirmer et postuler', 'confirmer et envoyer',
]);

export function isFinalOcrControlLabel(label) {
  return OCR_FINAL_CONTROL_LABELS.has(String(label ?? '').trim().toLocaleLowerCase());
}

function sourceEvidencePath(orderId, claim) {
  const startedAt = Number(claim?.startedAt);
  if (!ASSISTED_APPLICATION_ORDER_ID_RE.test(String(orderId)) || !Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
  return `assisted-application-uploads/${orderId}/run-${startedAt}-submit-portal-submit_failed.json.enc`;
}

async function decryptStoredJson(bucket, objectPath, key) {
  if (!objectPath || !key) return null;
  try {
    const [buffer] = await bucket.file(objectPath).download();
    return decryptJson(JSON.parse(Buffer.from(buffer).toString('utf8')), key);
  } catch {
    return null;
  }
}

async function screenshotTextOnMac(screenshotBase64) {
  if (process.platform !== 'darwin' || typeof screenshotBase64 !== 'string' || !screenshotBase64) return null;
  let dir = null;
  try {
    const image = Buffer.from(screenshotBase64, 'base64');
    if (image.length < 8) return null;
    dir = await mkdtemp(path.join(tmpdir(), 'aa-final-review-'));
    const imagePath = path.join(dir, 'after-submit.png');
    const sourcePath = path.join(dir, 'recognize.swift');
    await writeFile(imagePath, image, { mode: 0o600, flag: 'wx' });
    await writeFile(sourcePath, SWIFT_OCR, { mode: 0o600, flag: 'wx' });
    const { stdout } = await execFile('swift', [sourcePath, imagePath], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 512 * 1024,
    });
    const rows = JSON.parse(String(stdout || '[]'));
    if (!Array.isArray(rows)) return null;
    const orderedRows = [...rows].sort((left, right) => {
      const verticalDistance = Math.abs(Number(left?.y || 0) - Number(right?.y || 0));
      if (verticalDistance < 0.015) return Number(left?.x || 0) - Number(right?.x || 0);
      return Number(right?.y || 0) - Number(left?.y || 0);
    });
    const lines = orderedRows.map(row => String(row?.text || '').trim()).filter(Boolean);
    if (!lines.length) return null;
    const buttons = lines.filter(line => isFinalOcrControlLabel(line) && SUBMIT_RE.test(line))
      .map(text => ({ text, disabled: null, chrome: false }));
    return { text: lines.join('\n'), buttons };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function postClickSnapshot(source) {
  const evidence = source?.evidence || {};
  const finalUrl = String(evidence.finalUrl || '');
  const stored = evidence.afterSubmitSnapshot;
  if (stored && stored.url === finalUrl && typeof stored.text === 'string') return stored;
  const observed = await screenshotTextOnMac(evidence.afterSubmit);
  if (!observed || !finalUrl) return null;
  return { url: finalUrl, text: observed.text, protocol: evidence.sourceProtocol || null,
    errors: [], fields: [], buttons: observed.buttons };
}

function verificationShape(value = {}) {
  value ||= {};
  return JSON.stringify([
    value.state || null, value.round || null, value.version || null, value.nonce || null,
    value.requestedAt || null, value.startedAt || null, value.completedAt || null,
    value.expiresAt || null, value.conclusion || null, value.proofPath || null, value.binding || null,
  ]);
}

async function laterVerificationStatus({ verification, clickedAt, round, orderId, bucket, key }) {
  if (!verification) return { clear: true, found: false };
  if (verification.conclusion && ['found', 'submitted', 'confirmed', 'received'].includes(String(verification.conclusion))) {
    return { clear: false, found: true };
  }
  if (Number(verification.round) !== round) return { clear: false, found: false };
  const requestedAt = Number(verification.requestedAt) || 0;
  const startedAt = Number(verification.startedAt) || 0;
  const completedAt = Number(verification.completedAt) || 0;
  if (verification.state !== 'completed') {
    const lastObservedAt = Math.max(requestedAt, startedAt, completedAt);
    const inactive = !['requested', 'running'].includes(String(verification.state || ''));
    return { clear: inactive && lastObservedAt > 0 && lastObservedAt <= clickedAt, found: false };
  }
  if (!verification.proofPath
    || !verification.proofPath.startsWith(`assisted-application-uploads/${orderId}/run-`)
    || !verification.proofPath.endsWith('-portal-verification.json.enc')) return { clear: false, found: false };
  const proof = await decryptStoredJson(bucket, verification.proofPath, key);
  if (!proof || Number(proof.round) !== round) return { clear: false, found: false };
  const conclusion = String(proof.proof?.conclusion || '');
  if (['found', 'submitted', 'confirmed', 'received'].includes(conclusion)) return { clear: false, found: true };
  if (conclusion !== 'unknown') return { clear: false, found: false };
  if (!completedAt) return { clear: false, found: false };
  return { clear: true, found: false };
}

async function readContext(ref, read = item => item.get()) {
  const [order, flow, draft, submission, verification, inbox] = await Promise.all([
    read(ref),
    read(ref.collection('automation').doc('flow')),
    read(ref.collection('ai_drafts').doc('current')),
    read(ref.collection('automation').doc('submission')),
    read(ref.collection('automation').doc('portal_verification')),
    read(ref.collection('inbox')),
  ]);
  return {
    order: order.data() || {}, flow: flow.data() || {}, draft: draft.data() || {},
    submission: submission.data() || {}, verification: verification.data() || null,
    inbox: (inbox.docs || []).map(doc => doc.data() || {}),
  };
}

function decisionFor(context, { source, sourcePathBound, snapshot, submissionUrl, laterClear, nowMs }) {
  return decideFinalReviewAmbiguousReconciliation({
    ...context, source, sourcePathBound, postClickSnapshot: snapshot,
    submissionUrl, laterVerificationClear: laterClear.clear, laterVerificationFound: laterClear.found, nowMs,
  });
}

async function applyReconciliation({ db, ref, source, sourcePath, sourceStartedAt,
  snapshot, submissionUrl, laterClear, verificationBefore, nowMs }) {
  return db.runTransaction(async transaction => {
    const current = await readContext(ref, item => transaction.get(item));
    const round = Number(current.flow.round) || 1;
    const claim = current.submission[`r${round}`] || {};
    const sourcePathBound = Boolean(sourcePath && Number(claim.startedAt) === sourceStartedAt);
    const latestVerificationClear = verificationShape(current.verification) === verificationBefore
      ? laterClear : { clear: false, found: false };
    const decision = decisionFor(current, {
      source, sourcePathBound, snapshot, submissionUrl,
      laterClear: latestVerificationClear, nowMs: Math.max(nowMs, Date.now()),
    });
    if (decision.decision !== 'reconcile') return false;

    const dueAt = nowMs + PORTAL_AUTO_RETRY_DELAYS_MS[0];
    const roundKey = `r${round}`;
    transaction.set(ref.collection('automation').doc('submission'), {
      [roundKey]: confirmedNotSentRecord(claim, 'portal_review_pending', nowMs),
    }, { merge: true });
    transaction.set(ref.collection('ai_drafts').doc('current'), { sentAttempt: null }, { merge: true });
    transaction.set(ref.collection('automation').doc('flow'), {
      portalAutoRetryCount: PORTAL_AUTO_RETRY_DELAYS_MS.length,
      portalAutoRetryAt: dueAt,
      portalFinalReviewAmbiguousRecoveryVersion: RECOVERY_VERSION,
      updatedAt: nowMs,
    }, { merge: true });
    transaction.set(ref, { automationDueAt: dueAt, automationUpdatedAt: new Date(nowMs) }, { merge: true });
    transaction.set(ref.collection('events').doc(), buildAssistedApplicationEvent('automation_transition', {
      actor: 'reconcile:final-review-ambiguous',
      eventType: 'portal_final_review_ambiguous_reconciled',
      fromState: current.flow.state,
      toState: current.flow.state,
      round,
      recoveryVersion: RECOVERY_VERSION,
    }));
    return true;
  });
}

/** Dry-run by default. Applying only records a proven no-send and queues one delayed recovery dispatch. */
export async function reconcileFinalReviewAmbiguous({ db, bucket, key = null, apply = false,
  nowMs = Date.now(), isEnabled = null } = {}) {
  const results = [];
  let remoteConfigTemplate = null;
  if (!isEnabled || !key) remoteConfigTemplate = await getRemoteConfig().getTemplate();
  if (!isEnabled) {
    const template = remoteConfigTemplate;
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = orderId => flag.all || flag.orders.has(orderId);
  }
  let runKey = key;
  if (!runKey) {
    try { runKey = runKeyFrom(); }
    catch {
      try { runKey = runKeyFrom(remoteConfigTemplate?.parameters?.[RUN_KEY_REMOTE_CONFIG_PARAM]?.defaultValue?.value); }
      catch { runKey = null; }
    }
  }
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover')
      .orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const context = await readContext(doc.ref);
      if (context.flow.heldBy?.length !== 1 || context.flow.heldBy[0] !== 'portal_ambiguous') continue;
      if (!(await isEnabled(doc.id))) continue;

      const round = Number(context.flow.round) || 1;
      const claim = context.submission[`r${round}`] || {};
      const sourcePath = sourceEvidencePath(doc.id, claim);
      const source = await decryptStoredJson(bucket, sourcePath, runKey);
      const snapshot = await postClickSnapshot(source);
      const submissionUrl = String(source?.evidence?.submissionUrl || source?.evidence?.steps?.at(-1)?.url || '');
      const clickedAt = Number(claim.clickedAt) || 0;
      const verificationClear = await laterVerificationStatus({ verification: context.verification,
        clickedAt, round, orderId: doc.id, bucket, key: runKey });
      const verificationBefore = verificationShape(context.verification);
      const sourcePathBound = Boolean(sourcePath && Number(claim.startedAt) > 0);
      const result = decisionFor(context, {
        source, sourcePathBound, snapshot, submissionUrl, laterClear: verificationClear, nowMs,
      });
      let decision = result.decision;
      if (apply && decision === 'reconcile') {
        const committed = await applyReconciliation({ db, ref: doc.ref,
          source, sourcePath, sourceStartedAt: Number(claim.startedAt), snapshot, submissionUrl,
          laterClear: verificationClear, verificationBefore, nowMs });
        decision = committed ? 'reconciled' : 'raced_or_changed';
      }
      results.push({ order: doc.id.slice(0, 8), criteria: result.criteria, decision });
    }
    cursor = page.docs.length === PAGE_SIZE ? page.docs.at(-1) : null;
  } while (cursor);
  return results;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg))
    || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-final-review-ambiguous.mjs [--dry-run | --apply]');
  }
  try {
    const db = await getFirestoreDb();
    const bucket = getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
    const results = await reconcileFinalReviewAmbiguous({ db, bucket, apply: args.includes('--apply') });
    for (const result of results) console.log(JSON.stringify(result));
  } catch {
    console.error('final_review_ambiguous_reconciliation_failed');
    process.exitCode = 1;
  }
}
