/** Report a failed executor even when the agent could not import its modules. */
import { readFile } from 'node:fs/promises';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { ASSISTED_APPLICATION_ORDER_ID_RE } from '../../functions/src/assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { isUnconfirmedSubmission } from '../../functions/src/assistedApplicationSubmissionGuard.js';
import { runKeyFrom, storeEvidence } from './lib/secure-run.mjs';

export async function reportRunnerFailure({ db, orderId, mode, round, runId, startedAt, nowMs = Date.now() }) {
  if (!ASSISTED_APPLICATION_ORDER_ID_RE.test(String(orderId || '')) || !['draft', 'submit', 'dry_run'].includes(mode)
    || !Number.isSafeInteger(round) || round < 1 || !/^\d+$/.test(String(runId || '')) || !(startedAt > 0)) throw new Error('invalid_runner_failure_context');
  if (mode === 'dry_run') return { reported: false, reason: 'dry_run' };
  const orderRef = db.collection('assisted_applications').doc(orderId);
  const eventRef = orderRef.collection('automation_events').doc(`runner-${runId}-failure`);
  return db.runTransaction(async transaction => {
    const [orderDoc, flowDoc, submissionDoc, previous] = await Promise.all([
      transaction.get(orderRef), transaction.get(orderRef.collection('automation').doc('flow')),
      transaction.get(orderRef.collection('automation').doc('submission')), transaction.get(eventRef),
    ]);
    const order = orderDoc.data();
    const flow = flowDoc.data();
    if (previous.exists) return { reported: false, reason: 'already_reported' };
    const expected = mode === 'submit' ? ['submitting'] : ['drafting', 'regenerating'];
    if (order?.paymentStatus !== 'paid' || order.withdrawnAt || order.retentionPurgedAt
      || ['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus) || ['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
      || !expected.includes(flow?.state) || Number(flow.round || 1) !== round
      || Number(flow.dispatch?.requestedAt || 0) > startedAt) return { reported: false, reason: 'superseded' };
    const send = submissionDoc.data()?.[`r${round}`];
    const event = mode === 'submit' && send?.state === 'sent'
      ? { type: 'submit_succeeded', channel: send.channel }
      : { type: mode === 'draft' ? 'draft_failed' : 'submit_failed', error: mode === 'submit' && isUnconfirmedSubmission(send)
        ? send.channel === 'email' ? 'email_ambiguous' : 'portal_ambiguous' : 'runner_infrastructure_unavailable' };
    transaction.set(eventRef, { ...event, round, mode, runId: String(runId), createdAt: nowMs });
    return { reported: true, event: event.type };
  });
}

if (isInvokedDirectly(import.meta.url)) {
  const db = await getFirestoreDb();
  const orderId = process.env.ORDER_ID;
  const runId = process.env.GITHUB_RUN_ID;
  const mode = process.env.MODE;
  const round = Number(process.env.ROUND);
  const startedAt = Number(process.env.AGENT_RUN_STARTED_AT);
  // Keep the boot traceback encrypted, never in a public issue or event.
  if (process.env.AGENT_BOOT_ERROR_FILE && ASSISTED_APPLICATION_ORDER_ID_RE.test(orderId || '')) {
    const bootError = await readFile(process.env.AGENT_BOOT_ERROR_FILE, 'utf8').catch(() => '');
    if (bootError && process.env.ASSISTED_APPLICATION_RUN_KEY) {
      const { getStorage } = await import('firebase-admin/storage');
      await storeEvidence({ bucket: getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET), orderId,
        name: 'runner-boot-failed', key: runKeyFrom(), payload: { runId, mode, round, bootError: bootError.slice(0, 60000) } });
    }
  }
  console.log(JSON.stringify(await reportRunnerFailure({ db, orderId, mode, round, runId, startedAt })));
}
