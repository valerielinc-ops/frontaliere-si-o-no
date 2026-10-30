#!/usr/bin/env node
/** Backfill legacy waits through the normal clock; defaults are never saved as CV facts. */
import { createHash } from 'node:crypto';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { transition } from '../../functions/src/assistedApplicationFlow.js';
import { OPERATIONAL_DEFAULTS_VERSION } from '../../functions/src/assistedApplicationOperationalAnswers.js';

export async function reconcileOperationalAnswers({ db, apply = false, nowMs = Date.now() }) {
  const counts = { scanned: 0, eligible: 0, queued: 0, alreadyQueued: 0 };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'needs_candidate_action')
      .orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (!page.docs.length) break;
    for (const doc of page.docs) {
      counts.scanned++;
      if (doc.data().paymentStatus !== 'paid' || doc.data().refundStatus === 'pending') continue;
      const outcome = await db.runTransaction(async transaction => {
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(doc.ref.collection('automation').doc('flow')), transaction.get(doc.ref.collection('ai_drafts').doc('current')),
        ]);
        const order = orderDoc.data();
        if (order?.paymentStatus !== 'paid' || order.refundStatus === 'pending') return null;
        const flow = flowDoc.data();
        // A later portal step may create another wait on this same order.
        // Deduplicate the wait episode, not every future use of this policy.
        const waitKey = createHash('sha256').update(JSON.stringify([
          OPERATIONAL_DEFAULTS_VERSION, flow?.round, [...(flow?.heldBy || [])].sort(),
          flow?.dispatch?.requestedAt || null, flow?.heldSince || null,
        ])).digest('hex');
        if (order.operationalAnswerReconciledKey === waitKey) return 'alreadyQueued';
        const result = transition(flow, { type: 'tick' }, {
          draft: draftDoc.data(), answers: flow?.answers || {}, documents: flow?.documents || {}, nowMs,
        });
        if (!result.effects.some(effect => effect.type === 'dispatch' && effect.reason === 'resolved_candidate_answers')) return null;
        // Only repair the query clock. The scheduled sweep rechecks the current
        // posting and state machine before dispatching any application.
        if (apply) transaction.set(doc.ref, {
          automationDueAt: nowMs,
          operationalAnswerReconciledVersion: OPERATIONAL_DEFAULTS_VERSION,
          operationalAnswerReconciledKey: waitKey,
        }, { merge: true });
        return apply ? 'queued' : 'eligible';
      });
      if (outcome) {
        if (outcome !== 'alreadyQueued') counts.eligible++;
        if (outcome !== 'eligible') counts[outcome]++;
      }
    }
    cursor = page.docs.at(-1);
    if (page.docs.length < 100) break;
  } while (cursor);
  return counts;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-operational-answers.mjs [--dry-run | --apply]');
  }
  const db = await getFirestoreDb();
  console.log(JSON.stringify(await reconcileOperationalAnswers({ db, apply: args.includes('--apply') })));
}
