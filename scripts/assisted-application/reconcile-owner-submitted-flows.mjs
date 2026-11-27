#!/usr/bin/env node
/**
 * Orders the owner marked sent (queue, or the fill extension) whose automation flow was not closed.
 *
 * The queue wrote `submissionStatus: submitted` while the flow was still `submitting` (the robot had been
 * relaunched) or the close was lost, and a later runner handoff put the flow back on the owner. The order
 * says sent, the flow says it is waiting: the automation box disagrees with the queue.
 *
 * Each such order gets the flow's own `owner_submitted` event, through recordOwnerSubmission
 * (assistedApplicationAutomationAdmin.js): the flow closes, the round's send record is written as the owner's
 * confirmation, and the order is not touched again (the mark_submitted effect is a no-op on an order already
 * sent), so no e-mail leaves and no run is dispatched. A second run finds the flow closed and does nothing.
 *
 * Skipped: a flow that already ended (submitted, withdrawn), a flow waiting for the candidate (the candidate
 * may still act: the owner decides), a postal submission (only the candidate confirms it).
 *
 * Dry run by default; `--apply` writes. `--list` also prints the first 8 characters of each order id with its
 * outcome (never in a public CI log: this repository is public).
 */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { OWNER_SUBMITTED_STATES, transition } from '../../functions/src/assistedApplicationFlow.js';
import { recordOwnerSubmission } from '../../functions/src/assistedApplicationAutomationAdmin.js';
import { runAutomationEffect } from '../../functions/src/assistedApplicationAutomationEffects.js';

export const OWNER_SUBMITTED_RECONCILE_ACTOR = 'reconcile-owner-submitted-flows';
const PAGE = 100;

/** Why a sent order's flow is left as it is, or '' when it is eligible (pure; recordOwnerSubmission re-reads). */
export function ownerSubmittedFlowBlocker({ order = {}, flow = null, nowMs = Date.now() } = {}) {
  if (order.submissionStatus !== 'submitted') return 'not_submitted';
  if (!flow || !flow.state) return 'no_flow';
  if (flow.state === 'submitted' || flow.state === 'withdrawn') return 'flow_closed';
  if (!OWNER_SUBMITTED_STATES.has(flow.state)) return 'waiting_for_candidate';
  const step = transition(flow, { type: 'owner_submitted' }, { nowMs });
  return step.ignored || '';
}

/**
 * @param {{db, apply?:boolean, nowMs?:number, runEffect?:Function}} options
 */
export async function reconcileOwnerSubmittedFlows({ db, apply = false, nowMs = Date.now(), runEffect = runAutomationEffect } = {}) {
  const summary = { scanned: 0, open: 0, eligible: 0, closed: 0, skipped: {}, apply, orders: [] };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('submissionStatus', '==', 'submitted').orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned += 1;
      const order = doc.data() || {};
      // The mirror on the order is only a filter; the flow document decides.
      if (!order.automationState || order.automationState === 'submitted') continue;
      const flowDoc = await doc.ref.collection('automation').doc('flow').get();
      const flow = flowDoc.exists ? flowDoc.data() || {} : null;
      if (flow?.state === 'submitted') continue;
      summary.open += 1;
      let outcome = ownerSubmittedFlowBlocker({ order, flow, nowMs });
      if (!outcome && apply) {
        const result = await recordOwnerSubmission({
          db, orderId: doc.id, adminEmail: OWNER_SUBMITTED_RECONCILE_ACTOR, via: 'owner', runEffect, nowMs,
        });
        outcome = result.ok ? '' : result.ignored || 'not_allowed';
      }
      summary.orders.push({ id: doc.id.slice(0, 8), state: flow?.state || null, outcome: outcome || (apply ? 'closed' : 'eligible') });
      if (outcome) {
        summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
        continue;
      }
      summary.eligible += 1;
      if (apply) summary.closed += 1;
    }
    cursor = page.docs.length === PAGE ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = ['--apply', '--dry-run', '--list'];
  if (args.some((arg) => !known.includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-owner-submitted-flows.mjs [--dry-run | --apply] [--list]');
  }
  const { orders, ...counts } = await reconcileOwnerSubmittedFlows({ db: await getFirestoreDb(), apply: args.includes('--apply') });
  console.log(JSON.stringify(args.includes('--list') ? { ...counts, orders } : counts));
}
