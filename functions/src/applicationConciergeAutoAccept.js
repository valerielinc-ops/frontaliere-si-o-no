/**
 * The platform's acceptance of the concierge proposals a candidate leaves undecided (owner decision 2026-11-11).
 *
 * An eligible proposal still "proposed" CONCIERGE_AUTO_ACCEPT_MS after its verified announcement was sent is
 * accepted through the candidate's own acceptance path (autoAcceptApplicationConciergeProposal): the same
 * ownership, service, quota and eligibility checks, the same CV copy and the same transaction, which reads the
 * proposal again and refuses it once the candidate has declined or accepted it. The child application then
 * leaves with the platform's answers like any other.
 *
 * Runs inside the existing 15-minute lifecycle tick (sweepApplicationConciergeLifecycle), never its own cron.
 * At most one proposal per service per tick: an acceptance queues a new matching run, and the next acceptance
 * waits for it exactly as the candidate's button does. At most CONCIERGE_AUTO_ACCEPT_MAX_PER_TICK attempts per
 * tick, so the proposals already older than 12 hours at deploy time are accepted over the next ticks, counted.
 */
import { FieldValue } from 'firebase-admin/firestore';
import {
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  serviceIsActive,
  servicePositionLimit,
  timestampMillis,
} from './applicationConciergeConstants.js';
import {
  conciergeAutoAcceptDue,
  conciergeProposalDecisionOpenedAt,
  conciergeProposalNoticeDecisionReady,
} from './applicationConciergeLifecyclePolicy.js';
import { autoAcceptApplicationConciergeProposal, proposalAcceptability } from './applicationConciergeCore.js';
import { checkPostingLiveness, postingSaysClosed } from './assistedApplicationLiveness.js';
import { conciergeMatchingRuntimeRef, mergeConciergeMatchingRuntime } from './applicationConciergeRuntime.js';

// 10 attempts × (one ad look of at most 10 s + one acceptance) stay well inside the tick's 540 s, which the
// lifecycle sweep and the material-copy cleanup share; at 4 ticks an hour the backlog drains at 40 an hour.
export const CONCIERGE_AUTO_ACCEPT_MAX_PER_TICK = 10;
// A posting found closed is looked at again only after this, so closed ads cannot use up every tick's budget.
export const CONCIERGE_AUTO_ACCEPT_POSTING_RECHECK_MS = 6 * 60 * 60 * 1000;
export const CONCIERGE_AUTO_ACCEPT_POSTING_LOOK_MS = 10_000;

const REFUND_STATUSES = new Set(['pending', 'completed', 'succeeded', 'refunded']);

/** The proposal's ad says it is closed (assistedApplicationLiveness.js), read now. Any failure reads as open. */
export async function conciergeProposalPostingClosed({ proposal, fetchImpl = fetch, resolve } = {}) {
  const jobUrl = String(proposal?.jobUrl || '');
  if (!jobUrl) return false;
  const liveness = await checkPostingLiveness({
    order: { jobId: proposal?.jobId, jobUrl },
    posting: { postingUrl: jobUrl },
    fetchImpl,
    resolve,
  });
  return postingSaysClosed(liveness);
}

function lookWithin(look, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    Promise.resolve().then(look).then(closed => resolve(Boolean(closed)), () => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

function serviceBlockReason(service, nowMs) {
  if (service?.refundedAt || REFUND_STATUSES.has(service?.refundStatus)) return 'service_refunded';
  if (!serviceIsActive(service, nowMs)) return 'service_inactive';
  if (acceptedPositionsCount(service) >= servicePositionLimit(service)) return 'quota_exhausted';
  return '';
}

function postingHeld(proposal, nowMs) {
  const hold = proposal?.autoAcceptHold;
  return hold?.reason === 'posting_closed' && nowMs - timestampMillis(hold.at) < CONCIERGE_AUTO_ACCEPT_POSTING_RECHECK_MS;
}

async function holdForClosedPosting(db, ref, nowMs) {
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || (snapshot.data() || {}).status !== 'proposed') return;
    tx.set(ref, { autoAcceptHold: { reason: 'posting_closed', at: new Date(nowMs) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

/**
 * @param {object} options
 * @param {FirebaseFirestore.Firestore} options.db
 * @param {number} [options.nowMs]
 * @param {Function} [options.accept] autoAcceptApplicationConciergeProposal
 * @param {Function|null} [options.postingClosed] ({ proposal }) => boolean; null looks at no ad
 * @param {number} [options.maxPerTick]
 */
export async function runConciergeAutoAcceptSweep({
  db,
  nowMs = Date.now(),
  accept = autoAcceptApplicationConciergeProposal,
  postingClosed = conciergeProposalPostingClosed,
  maxPerTick = CONCIERGE_AUTO_ACCEPT_MAX_PER_TICK,
  postingLookMs = CONCIERGE_AUTO_ACCEPT_POSTING_LOOK_MS,
} = {}) {
  const summary = { services: 0, due: 0, attempted: 0, accepted: 0, deferred: 0, failed: 0, skipped: {} };
  const skip = (reason, count = 1) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + count; };
  const services = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('paymentStatus', '==', 'paid').get();
  for (const serviceDoc of services.docs || []) {
    const service = serviceDoc.data() || {};
    if (!serviceIsActive(service, nowMs)) continue;
    summary.services += 1;
    const runtimeSnapshot = await conciergeMatchingRuntimeRef(serviceDoc.ref).get();
    const runtime = runtimeSnapshot.data() || null;
    const currentService = mergeConciergeMatchingRuntime(service, runtime);
    const proposals = await serviceDoc.ref.collection('proposals').where('status', '==', 'proposed').get();
    const due = (proposals.docs || [])
      .filter(doc => proposalAcceptability(currentService, doc.data() || {}, runtime).acceptable)
      .filter(doc => conciergeProposalNoticeDecisionReady(currentService, doc.data() || {}))
      .filter(doc => conciergeAutoAcceptDue(doc.data() || {}, nowMs))
      .sort((left, right) => conciergeProposalDecisionOpenedAt(left.data()) - conciergeProposalDecisionOpenedAt(right.data())
        || String(left.id).localeCompare(String(right.id)));
    if (!due.length) continue;
    summary.due += due.length;
    const blocked = serviceBlockReason(service, nowMs);
    if (blocked) { skip(blocked, due.length); continue; }
    // Eligibility is rechecked per proposal before the clock is even read.
    const acceptable = due;
    let handled = 0;
    for (const proposalDoc of acceptable) {
      const proposal = proposalDoc.data() || {};
      if (postingHeld(proposal, nowMs)) { handled += 1; skip('posting_closed'); continue; }
      if (summary.attempted >= maxPerTick) break;
      handled += 1;
      summary.attempted += 1;
      try {
        if (postingClosed && await lookWithin(() => postingClosed({ db, serviceId: serviceDoc.id, proposalId: proposalDoc.id, proposal }), postingLookMs)) {
          await holdForClosedPosting(db, proposalDoc.ref, nowMs);
          skip('posting_closed');
          continue;
        }
        const result = await accept({ db, serviceId: serviceDoc.id, proposalId: proposalDoc.id, nowMs });
        if (result?.accepted) summary.accepted += 1;
        else skip(result?.reason || 'refused');
      } catch (error) {
        summary.failed += 1;
        console.error('[conciergeAutoAccept]', serviceDoc.id.slice(0, 8), proposalDoc.id.slice(0, 8), error?.code || error?.name || 'unknown');
      }
      // One acceptance attempt per service per tick: it queues the matching run the next one waits for.
      break;
    }
    summary.deferred += due.length - handled;
  }
  if (summary.due || summary.failed) console.log('[conciergeAutoAccept]', JSON.stringify(summary));
  return summary;
}
