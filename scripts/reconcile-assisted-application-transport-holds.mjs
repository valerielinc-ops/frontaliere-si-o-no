#!/usr/bin/env node
/** After deploying the updated Functions policy, normalize definitely unsent
 * legacy holds; the regular clock owns every retry. Default is read-only. */
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { roundWasSent } from '../functions/src/assistedApplicationFlow.js';
import { legacyTransportHoldReason } from '../functions/src/assistedApplicationTransportRetryPolicy.js';

export const TRANSPORT_RECOVERY_VERSION = 'transport-recovery-v1';

export async function reconcileTransportHolds({ db, apply = false, nowMs = Date.now() }) {
  const summary = { scanned: 0, eligible: 0, changed: 0, apply };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover').orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned++;
      const eligible = await db.runTransaction(async transaction => {
        const flowRef = doc.ref.collection('automation').doc('flow');
        const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(flowRef), transaction.get(doc.ref.collection('ai_drafts').doc('current')),
          transaction.get(doc.ref.collection('automation').doc('submission')),
        ]);
        const order = orderDoc.data();
        const flow = flowDoc.data();
        const draft = draftDoc.data();
        if (order?.paymentStatus !== 'paid' || order.withdrawnAt || order.retentionPurgedAt || ['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
          || ['pending', 'succeeded', 'refunded'].includes(order.refundStatus)) return false;
        const reason = legacyTransportHoldReason({ flow, draft, submission: submissionDoc.data() });
        if (!reason || draft?.status !== 'ready' || Number(draft.round) !== Number(flow.round || 1) || !roundWasSent(flow)) return false;
        const heldBy = [`${reason === 'email_provider_unavailable' ? 'transport' : 'portal'}:${reason}`];
        const attempts = Number(flow.transportAutoRetryCount) || 0;
        if (!Number.isSafeInteger(attempts) || attempts < 0) return false;
        if (apply) {
          transaction.set(flowRef, {
            heldBy, portalAutoRetryAt: nowMs, technicalRecoveryVersion: TRANSPORT_RECOVERY_VERSION, updatedAt: nowMs,
          }, { merge: true });
          transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), {
            type: 'transport_recovery_scheduled', actor: 'system', at: nowMs, version: TRANSPORT_RECOVERY_VERSION,
          });
        }
        return true;
      });
      if (eligible) {
        summary.eligible++;
        if (apply) summary.changed++;
      }
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-assisted-application-transport-holds.mjs [--dry-run | --apply]');
  }
  console.log(JSON.stringify(await reconcileTransportHolds({ db: await getFirestoreDb(), apply: args.includes('--apply') })));
}
