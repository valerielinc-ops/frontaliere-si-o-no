#!/usr/bin/env node
/**
 * Orders stopped for a closed ad before the owner decision of 2026-11-11 («Comunichiamo che le posizioni sono
 * state ritirate e che l'application è stata ritirata. quindi va in archiviati, nessun rimborso»).
 *
 * Two stops, while the round waited for the candidate, refunded nothing and waited for Valerie:
 *   - the runner's `posting_closed` (owner_takeover, heldBy ['posting_closed'], reason posting_closed_waited):
 *     the proof is the runner's own event of the round (`automation_events`: HTTP 404/410, the posting's or
 *     the portal's closure statement, the ATS's own answer);
 *   - the sweep's look before a reminder (candidate_review / needs_candidate_action with postingExpiredAt,
 *     the order silent since): the proof is read again now, at the address the sweep reads
 *     (postingClosureForOrder), and only the posting's own word counts.
 * The flow now withdraws such an order by itself (assistedApplicationFlow.js, posting_closure_recorded):
 * this script records the proof on the flow and makes the order due. The Cloud Functions sweep then applies
 * the transition and its one keyed e-mail to the candidate. Nothing is refunded, sent or dispatched here.
 *
 * Skipped, and left to Valerie: a proof that is a reading of ours (our dataset, a page that looked empty), a
 * round that never waited for the candidate (the Terms promise a refund there), an application that may
 * have reached the employer, a refund on record, a purged order.
 *
 * Second pass (owner decision 2026-11-11, «si per il concierge lo libera»): a concierge child the employer's
 * withdrawal closed before the transition gave its position back (assistedApplicationAutomation.js) gets it
 * back here, in one transaction with its service: the counter drops by one and never below zero, the proposal
 * is closed for the employer's withdrawal, an active service asks the matcher for a replacement, and the child
 * is marked (`conciergeSlotReleasedAt`), so a second run releases nothing. Skipped: a send that may have left,
 * a proposal no longer accepted for that child, a service of someone else.
 *
 * Dry run by default; `--apply` writes. `--list` also prints the first 8 characters of each order id with
 * its outcome (never in a public CI log: this repository is public).
 */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { employerWithdrawalPending } from '../../functions/src/assistedApplicationFlow.js';
import { postingClosureForOrder } from '../../functions/src/assistedApplicationAutomation.js';
import {
  EMPLOYER_WITHDRAWAL_REASON,
  EMPLOYER_WITHDRAWAL_SLOT_RELEASE,
  employerWithdrawalSlotBlocker,
  nativeClosureOf,
  sendMayHaveLeft,
} from '../../functions/src/assistedApplicationEmployerWithdrawal.js';
import { readConciergeSlot, releaseConciergeSlot } from '../../functions/src/assistedApplicationWithdrawal.js';

export const POSTING_WITHDRAWAL_RECONCILE_VERSION = 'posting-withdrawal-v1';
export const CONCIERGE_SLOT_RECONCILE_VERSION = 'posting-withdrawal-slot-v1';
const PAGE = 100;

/** The latest applied posting_closed of the round, with its native proof, from the runner's events. */
export function nativeClosureFromRunnerEvents(events, round) {
  const closures = (events || [])
    .filter((event) => event?.type === 'posting_closed' && Number(event.round || 1) === Number(round || 1)
      && String(event.result || '') === 'applied')
    .map((event) => {
      const at = timeOf(event.appliedAt) || timeOf(event.createdAt) || 0;
      return { at, closure: nativeClosureOf(event, at || Date.now()) };
    })
    .sort((left, right) => right.at - left.at);
  // The last word of the runner decides: a later reading of ours does not borrow an earlier native proof.
  return closures[0]?.closure || null;
}

function timeOf(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Why an order is not reconciled, or '' when it is eligible (pure: the transaction re-reads every input). */
export function postingWithdrawalBlocker({ order = {}, flow = {}, draft = null, submission = {}, closure = null }) {
  if (order.paymentStatus !== 'paid') return 'not_paid';
  if (order.withdrawnAt || ['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)) return 'settled';
  if (['pending', 'succeeded', 'refunded'].includes(order.refundStatus) || order.automationRefund?.status) return 'refund_on_record';
  if (order.retentionPurgingAt || order.retentionPurgedAt || order.retentionPayloadPurgedAt) return 'purged';
  if (!stoppedForClosedPosting(flow)) return 'not_stopped_for_closed_posting';
  if (!closure) return 'no_native_proof';
  if (!employerWithdrawalPending({ ...flow, postingClosure: closure })) return 'round_did_not_wait';
  if (sendMayHaveLeft({ draft, submission })) return 'send_may_have_left';
  return '';
}

/** Held for the runner's posting_closed, or silent since the sweep found the ad closed. */
function stoppedForClosedPosting(flow) {
  if (flow?.state === 'owner_takeover') {
    return Array.isArray(flow.heldBy) && flow.heldBy.length === 1 && flow.heldBy[0] === 'posting_closed';
  }
  return ['candidate_review', 'needs_candidate_action'].includes(flow?.state) && Number(flow.postingExpiredAt) > 0;
}

const STOPPED_STATES = ['owner_takeover', 'candidate_review', 'needs_candidate_action'];

/** The posting's native proof for one stopped order: the runner's own event, or a fresh look for a silent one. */
async function closureFor({ db, doc, flow, look, nowMs }) {
  if (flow.state === 'owner_takeover') {
    const events = (await doc.ref.collection('automation_events').where('type', '==', 'posting_closed').get()).docs
      .map((event) => event.data() || {});
    return nativeClosureFromRunnerEvents(events, Number(flow.round) || 1);
  }
  const answer = await Promise.resolve()
    .then(() => look({ db, orderId: doc.id, order: doc.data() || {}, nowMs }))
    .catch(() => false);
  return answer?.closure || null;
}

/** Re-reads the order in a transaction; with `apply`, records the proof and makes the order due. */
async function recordClosure({ db, doc, closure, apply, nowMs }) {
  const flowRef = doc.ref.collection('automation').doc('flow');
  return db.runTransaction(async (transaction) => {
    const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
      transaction.get(doc.ref),
      transaction.get(flowRef),
      transaction.get(doc.ref.collection('ai_drafts').doc('current')),
      transaction.get(doc.ref.collection('automation').doc('submission')),
    ]);
    const blocker = postingWithdrawalBlocker({
      order: orderDoc.data() || {},
      flow: flowDoc.data() || {},
      draft: draftDoc.exists ? draftDoc.data() || {} : null,
      submission: submissionDoc.data() || {},
      closure,
    });
    if (blocker || !apply) return blocker;
    transaction.set(flowRef, { postingClosure: closure, updatedAt: nowMs }, { merge: true });
    transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
    transaction.set(doc.ref.collection('events').doc(), {
      type: 'posting_withdrawal_recorded', actor: 'system', at: nowMs, version: POSTING_WITHDRAWAL_RECONCILE_VERSION,
      evidence: { kind: closure.code, source: closure.source, at: closure.at },
    });
    return '';
  });
}

/**
 * @param {{db, apply?:boolean, nowMs?:number, look?:Function}} options `look`: the live look at a silent
 *   order's posting (postingClosureForOrder; a test seam). A look that fails proves nothing.
 */
export async function reconcilePostingWithdrawals({ db, apply = false, nowMs = Date.now(), look = postingClosureForOrder } = {}) {
  const summary = { scanned: 0, stopped: 0, eligible: 0, recorded: 0, skipped: {}, apply, orders: [] };
  for (const state of STOPPED_STATES) {
    let cursor;
    do {
      let query = db.collection('assisted_applications').where('automationState', '==', state).orderBy('__name__').limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        summary.scanned += 1;
        const flow = (await doc.ref.collection('automation').doc('flow').get()).data() || {};
        if (!stoppedForClosedPosting(flow)) continue;
        summary.stopped += 1;
        const closure = await closureFor({ db, doc, flow, look, nowMs });
        const outcome = await recordClosure({ db, doc, closure, apply, nowMs });
        summary.orders.push({ id: doc.id.slice(0, 8), outcome: outcome || (apply ? 'recorded' : 'eligible'), ...(closure ? { evidence: closure.code } : {}) });
        if (outcome) {
          summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
          continue;
        }
        summary.eligible += 1;
        if (apply) summary.recorded += 1;
      }
      cursor = page.docs.length === PAGE ? page.docs.at(-1) : null;
    } while (cursor);
  }
  summary.slots = await reconcileConciergeSlots({ db, apply, nowMs });
  return summary;
}

/** Re-reads a withdrawn child in a transaction; with `apply`, gives its concierge position back. */
async function releaseSlot({ db, doc, apply, nowMs }) {
  return db.runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(doc.ref);
    const order = orderDoc.data() || {};
    const [flowDoc, draftDoc, submissionDoc, slot] = await Promise.all([
      transaction.get(doc.ref.collection('automation').doc('flow')),
      transaction.get(doc.ref.collection('ai_drafts').doc('current')),
      transaction.get(doc.ref.collection('automation').doc('submission')),
      readConciergeSlot(transaction, db, order),
    ]);
    const blocker = employerWithdrawalSlotBlocker({
      orderId: doc.id,
      order,
      flow: flowDoc.data() || {},
      draft: draftDoc.exists ? draftDoc.data() || {} : null,
      submission: submissionDoc.data() || {},
      slot,
    });
    if (blocker || !apply) return blocker;
    releaseConciergeSlot(transaction, slot, { orderId: doc.id, nowMs, ...EMPLOYER_WITHDRAWAL_SLOT_RELEASE });
    transaction.set(doc.ref, { conciergeSlotReleasedAt: nowMs, updatedAt: nowMs }, { merge: true });
    transaction.set(doc.ref.collection('events').doc(), {
      type: 'concierge_slot_released', actor: 'system', at: nowMs, reason: EMPLOYER_WITHDRAWAL_REASON,
      version: CONCIERGE_SLOT_RECONCILE_VERSION,
    });
    return '';
  });
}

/** The concierge children already withdrawn for the employer's withdrawal whose position is still held. */
export async function reconcileConciergeSlots({ db, apply = false, nowMs = Date.now() } = {}) {
  const summary = { scanned: 0, eligible: 0, released: 0, skipped: {}, orders: [] };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('withdrawalReason', '==', EMPLOYER_WITHDRAWAL_REASON)
      .orderBy('__name__').limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const order = doc.data() || {};
      // Only concierge children hold a position; the order read decides, the transaction reads it again.
      if (order.billingMode !== 'application_concierge' || order.conciergeSlotReleasedAt) continue;
      summary.scanned += 1;
      const outcome = await releaseSlot({ db, doc, apply, nowMs });
      summary.orders.push({ id: doc.id.slice(0, 8), outcome: outcome || (apply ? 'released' : 'eligible') });
      if (outcome) {
        summary.skipped[outcome] = (summary.skipped[outcome] || 0) + 1;
        continue;
      }
      summary.eligible += 1;
      if (apply) summary.released += 1;
    }
    cursor = page.docs.length === PAGE ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = ['--apply', '--dry-run', '--list'];
  if (args.some((arg) => !known.includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-posting-withdrawals.mjs [--dry-run | --apply] [--list]');
  }
  const { orders, slots: { orders: slotOrders, ...slotCounts }, ...counts } = await reconcilePostingWithdrawals({ db: await getFirestoreDb(), apply: args.includes('--apply') });
  console.log(JSON.stringify(args.includes('--list')
    ? { ...counts, orders, slots: { ...slotCounts, orders: slotOrders } }
    : { ...counts, slots: slotCounts }));
}
