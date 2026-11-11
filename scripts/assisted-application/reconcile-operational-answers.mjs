#!/usr/bin/env node
/**
 * Backfill legacy waits through the normal clock; defaults are never saved as CV facts.
 * Since the platform defaults (owner decision 2026-11-09) it also releases reviews held
 * by questions the platform now answers, and stores the job's salary estimate on a paid
 * order that has none (the salary expectation is its maximum).
 */
import { createHash } from 'node:crypto';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { transition } from '../../functions/src/assistedApplicationFlow.js';
import { OPERATIONAL_DEFAULTS_VERSION } from '../../functions/src/assistedApplicationOperationalAnswers.js';
import { orderSalaryEstimatePatch } from '../../functions/src/assistedApplicationJobCard.js';

const WAITING_STATES = ['needs_candidate_action', 'candidate_review'];

/**
 * A tick that releases the wait: a resumed submission, or a wait (a review, or a portal step waiting for the
 * candidate) whose question holds cleared, all of them or the ones the platform now answers while another
 * question or a document is still awaited (assistedApplicationFlow.js).
 */
export function releasesWait(flow, result) {
  if (result.effects.some(effect => effect.type === 'dispatch' && effect.reason === 'resolved_candidate_answers')) return true;
  const held = flow?.heldBy || [];
  return WAITING_STATES.includes(flow?.state)
    && held.some(item => /^(?:question|document):/.test(String(item)))
    && result.flow?.state === flow.state && (result.flow.heldBy || []).length < held.length;
}

export async function reconcileOperationalAnswers({ db, apply = false, nowMs = Date.now(), salaryEstimate = orderSalaryEstimatePatch }) {
  const counts = { scanned: 0, eligible: 0, queued: 0, alreadyQueued: 0, salaryEstimated: 0 };
  const salaryPatches = salaryEstimate ? await backfillSalaryEstimates({ db, apply, nowMs, salaryEstimate, counts }) : new Map();
  for (const state of WAITING_STATES) await reconcileState({ db, apply, nowMs, salaryPatches, state, counts });
  return counts;
}

/**
 * Orders written before the salary invariant (checkout before 2026-10-22, every concierge
 * application) receive the job's estimate, as the order trigger now gives a new one.
 */
async function backfillSalaryEstimates({ db, apply, nowMs, salaryEstimate, counts }) {
  const patches = new Map();
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('paymentStatus', '==', 'paid').orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (!page.docs.length) break;
    for (const doc of page.docs) {
      const order = doc.data();
      if (Number(order.salaryMax) > 0 || ['submitted', 'withdrawn'].includes(order.submissionStatus)) continue;
      const patch = await Promise.resolve(salaryEstimate(order)).catch(() => null);
      if (!patch) continue;
      counts.salaryEstimated++;
      patches.set(doc.id, patch);
      if (apply) await doc.ref.set({ ...patch, salaryEstimateCheckedAt: nowMs }, { merge: true });
    }
    cursor = page.docs.at(-1);
    if (page.docs.length < 100) break;
  } while (cursor);
  return patches;
}

async function reconcileState({ db, apply, nowMs, salaryPatches, state, counts }) {
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', state)
      .orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (!page.docs.length) break;
    for (const doc of page.docs) {
      counts.scanned++;
      if (doc.data().paymentStatus !== 'paid' || doc.data().refundStatus === 'pending') continue;
      // A dry run reads the order as the backfill would leave it.
      const salaryPatch = apply ? null : salaryPatches.get(doc.id);
      const outcome = await db.runTransaction(async transaction => {
        const [orderDoc, flowDoc, draftDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(doc.ref.collection('automation').doc('flow')), transaction.get(doc.ref.collection('ai_drafts').doc('current')),
        ]);
        const order = { ...orderDoc.data(), ...(salaryPatch || {}) };
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
          order, draft: draftDoc.data(), answers: flow?.answers || {}, documents: flow?.documents || {}, nowMs,
        });
        if (!releasesWait(flow, result)) return null;
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
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-operational-answers.mjs [--dry-run | --apply]');
  }
  const db = await getFirestoreDb();
  console.log(JSON.stringify(await reconcileOperationalAnswers({ db, apply: args.includes('--apply') })));
}
