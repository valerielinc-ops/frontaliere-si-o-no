#!/usr/bin/env node
/**
 * Orders stopped on `portal_ambiguous` whose page did not move after the final click but whose saved evidence
 * proves the application went (lib/portal/in-page-confirmation.mjs: the form gone, the employer's thank-you
 * visible after an answered same-origin send request, no error on screen).
 *
 * For each order in `owner_takeover` held by `portal_ambiguous`, whose round record is `sending` with a click
 * on record and no receipt, the encrypted evidence of that round's send run is decrypted (same key as
 * decrypt-run.mjs) and the SAME rule as the runner is applied to the saved `afterSubmitSnapshot`,
 * `diagnostics.responses` and `submissionUrl`. If it passes, a receipt of kind `portal_in_page_confirmation` is
 * written on the round's record and the flow receives `submit_acknowledged` through the receipt reconciliation.
 * If not, nothing is written. Nothing is ever sent again: no click, no run is dispatched.
 *
 * Runs older than the runner's own proof did not save whether the thank-you was already visible before the
 * click (`preSubmitConfirmationVisible`): for them the rule relies on the form being gone, which a hidden
 * thank-you block cannot explain, together with the answered send request and the visible message.
 *
 * Dry run by default; `--apply` writes; idempotent (a second run finds the record `sent` and the flow closed).
 * `--list` prints the first 8 characters of each order id with its outcome (never in a public CI log).
 */
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { submissionGuard, submissionRefFor } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import { reconcileSubmissionReceipt } from '../../functions/src/assistedApplicationReceiptReconcile.js';
import { applyAutomationEvent } from '../../functions/src/assistedApplicationAutomation.js';
import { runAutomationEffect } from '../../functions/src/assistedApplicationAutomationEffects.js';
import { decryptJson, runKeyFrom } from './lib/secure-run.mjs';
import { inPageConfirmation } from './lib/portal/in-page-confirmation.mjs';

export const INPAGE_RECONCILE_ACTOR = 'reconcile-inpage-confirmation';
const PAGE = 100;
// The evidence of the send run is written right after the click: a file much later belongs to another run.
const EVIDENCE_WINDOW_MS = 30 * 60 * 1000;

/** The same rule as the runner, on the fields a send run saved. Pure. */
export function inPageConfirmationFromEvidence(payload = {}) {
  const evidence = payload?.evidence || {};
  if (payload?.event?.type !== 'submit_failed' || payload.event.error !== 'portal_ambiguous') return { confirmed: false, reason: 'not_portal_ambiguous' };
  if ((evidence.finalOutcomes || []).at(-1) !== 'ambiguous') return { confirmed: false, reason: 'outcome_not_ambiguous' };
  if (evidence.finalButton?.by !== 'runner') return { confirmed: false, reason: 'final_click_not_the_runners' };
  const known = typeof evidence.preSubmitConfirmationVisible === 'boolean';
  if (known && evidence.preSubmitConfirmationVisible) return { confirmed: false, reason: 'confirmation_visible_before_click' };
  return inPageConfirmation({
    // A saved «not visible before» is a known empty text; an unsaved one is unknown (see the header).
    beforeText: known ? '' : null,
    allowUnknownBefore: !known,
    afterSnapshot: evidence.afterSubmitSnapshot || null,
    submissionUrl: evidence.submissionUrl || '',
    responses: evidence.diagnostics?.responses || [],
  });
}

/** Why an order's record is not eligible, or ''. */
export function inPageReconcileBlocker({ order = {}, flow = null, record = null } = {}) {
  if (!flow || flow.state !== 'owner_takeover') return 'flow_not_owner_takeover';
  if (!(flow.heldBy || []).includes('portal_ambiguous')) return 'not_held_by_portal_ambiguous';
  if (order.submissionStatus === 'submitted') return 'already_submitted';
  if (!record || record.state !== 'sending') return 'record_not_sending';
  if (record.channel !== 'portal' || !Number(record.clickedAt) || record.receipt) return 'no_click_or_already_receipted';
  if (!record.attemptId || !/^[a-f0-9]{64}$/.test(record.formBinding || '')) return 'record_unbound';
  return '';
}

async function runKey() {
  if (process.env.ASSISTED_APPLICATION_RUN_KEY) return runKeyFrom();
  const { getRemoteConfig } = await import('firebase-admin/remote-config');
  const template = await getRemoteConfig().getTemplate();
  return runKeyFrom(template.parameters?.ASSISTED_APPLICATION_RUN_KEY?.defaultValue?.value);
}

/** The decrypted send-run evidence of the round that clicked at `clickedAt`, or null. */
async function sendRunEvidence({ bucket, orderId, clickedAt, key }) {
  const [files] = await bucket.getFiles({ prefix: `assisted-application-uploads/${orderId}/run-` });
  const candidates = files
    .map((file) => ({ file, at: Number(/\/run-(\d+)-submit-portal-submit_failed\.json\.enc$/.exec(file.name)?.[1]) }))
    .filter(({ at }) => Number.isFinite(at) && at >= clickedAt && at <= clickedAt + EVIDENCE_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  if (!candidates.length) return null;
  const [content] = await candidates[0].file.download();
  return decryptJson(JSON.parse(content.toString('utf8')), key);
}

/**
 * @param {{db, bucket, key, apply?:boolean, nowMs?:number}} options
 */
export async function reconcileInPageConfirmation({ db, bucket, key, apply = false, nowMs = Date.now(), runEffect = runAutomationEffect } = {}) {
  const summary = { scanned: 0, eligible: 0, acknowledged: 0, skipped: {}, apply, orders: [] };
  const skip = (id, outcome) => {
    summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
    summary.orders.push({ id: id.slice(0, 8), outcome });
  };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover').orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned += 1;
      const order = doc.data() || {};
      const flowDoc = await doc.ref.collection('automation').doc('flow').get();
      const flow = flowDoc.exists ? flowDoc.data() || {} : null;
      const round = Number(flow?.round) || 1;
      const record = ((await submissionRefFor(db, doc.id).get()).data() || {})[`r${round}`] || null;
      const blocker = inPageReconcileBlocker({ order, flow, record });
      if (blocker) { skip(doc.id, blocker); continue; }
      const payload = await sendRunEvidence({ bucket, orderId: doc.id, clickedAt: Number(record.clickedAt), key });
      if (!payload) { skip(doc.id, 'no_send_run_evidence'); continue; }
      const verdict = inPageConfirmationFromEvidence(payload);
      if (!verdict.confirmed) { skip(doc.id, `not_proven:${verdict.reason}`); continue; }
      summary.eligible += 1;
      if (!apply) { summary.orders.push({ id: doc.id.slice(0, 8), outcome: 'eligible' }); continue; }
      const finalUrl = String(payload.evidence.finalUrl || payload.evidence.submissionUrl || '');
      await submissionGuard(db, doc.id, round).markSent({ ...record, channel: 'portal', finalUrl, sent: record.sent || {} }, nowMs, {
        kind: 'portal_in_page_confirmation', attemptId: record.attemptId, observedAt: nowMs, evidence: { finalUrl },
      });
      const result = await reconcileSubmissionReceipt({
        db, orderId: doc.id, nowMs, runEffect, applyEvent: (args) => applyAutomationEvent({ ...args, actor: INPAGE_RECONCILE_ACTOR }),
      });
      if (result.reconciled) summary.acknowledged += 1;
      summary.orders.push({ id: doc.id.slice(0, 8), outcome: result.reconciled ? 'acknowledged' : `receipt_written:${result.reason || 'pending'}` });
    }
    cursor = page.docs.length === PAGE ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, list: { type: 'boolean' } } });
  if (values.apply && values['dry-run']) throw new Error('Usage: reconcile-inpage-confirmation.mjs [--dry-run | --apply] [--list]');
  const db = await getFirestoreDb();
  const { getStorage } = await import('firebase-admin/storage');
  const { orders, ...counts } = await reconcileInPageConfirmation({
    db, bucket: getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET), key: await runKey(), apply: Boolean(values.apply),
  });
  console.log(JSON.stringify(values.list ? { ...counts, orders } : counts));
}
