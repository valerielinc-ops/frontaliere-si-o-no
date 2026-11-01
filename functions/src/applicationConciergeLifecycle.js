/** Scheduled lifecycle: refresh active services, deliver new proposals, then offer a renewal on expiry. */
import { inheritConciergeRenewalMaterials } from './applicationConciergeRenewalMaterials.js';
import { getNewsletterSecrets } from './remoteConfigSecrets.js';
import { paymentReminderUrl } from './applicationConciergePaymentReminders.js';
import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, APPLICATION_CONCIERGE_MAX_POSITIONS, acceptedPositionsCount, serviceIsActive, timestampMillis } from './applicationConciergeConstants.js';
import {
  conciergeMatchingRecoveryContext,
  conciergeRefreshDue,
  conciergeRenewalOffer,
  conciergeStaleRecoveryExhausted,
  CONCIERGE_MATCHING_STALE_AFTER_MS,
  CONCIERGE_STALE_RECOVERY_BACKOFF_MS,
  CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
} from './applicationConciergeLifecyclePolicy.js';
import * as conciergeMatcher from './applicationConciergeMatching.js';
const { runApplicationConciergeMatching } = conciergeMatcher;
import { buildConciergeNewJobsEmail, buildConciergeRenewalEmail } from './applicationConciergeLifecycleEmails.js';
import { sendOrderNotification } from './assistedApplicationNotifications.js';
import { enrichAssistedApplicationOrders } from './assistedApplicationJobCard.js';

const REFRESH_LEASE_MS = 10 * 60 * 1000;
// processApplicationConciergeCv is capped at 540s; never reclaim a live worker before that cap.
const WORKER_LEASE_MS = 10 * 60 * 1000;
function underCap(service) {
  return acceptedPositionsCount(service) < (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS);
}

export function isFreshConciergeProposalRefreshRequest(before, after) {
  const requestedBy = after?.proposalRefreshRequestedBy;
  return Boolean(
    (requestedBy === 'lifecycle' || requestedBy === 'candidate_withdrawal')
      && after?.proposalRefreshRequestId
      && after.proposalRefreshRequestId !== before?.proposalRefreshRequestId,
  );
}

async function claimRefresh(db, ref, nowMs) {
  const requestId = randomUUID();
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const service = snapshot.data();
    if (!snapshot.exists || service?.pendingProposalNotice || !conciergeRefreshDue(service, nowMs)) return false;
    const claimed = timestampMillis(service.proposalRefreshClaimedAt);
    if (claimed && nowMs - claimed < REFRESH_LEASE_MS) return false;
    tx.set(ref, { proposalRefreshClaimedAt: new Date(nowMs), proposalRefreshClaimId: requestId,
      proposalRefreshRequestId: requestId, proposalRefreshRequestedBy: 'lifecycle',
      proposalRefreshRerunAfterWorker: FieldValue.delete(),
      proposalRefreshRerunAfterWorkerContext: FieldValue.delete(),
      proposalRefreshRerunRequestedAt: FieldValue.delete() }, { merge: true });
    return requestId;
  });
}

function staleRecoveryAttempt(service, nowMs) {
  const context = conciergeMatchingRecoveryContext(service);
  const sameContext = service?.matchingStaleRecoveryContext === context;
  const attempts = sameContext ? Math.max(0, Math.floor(Number(service.matchingStaleRecoveryAttempt) || 0)) : 0;
  const retryAt = sameContext ? timestampMillis(service.matchingStaleRecoveryRetryAt) : 0;
  const startedAt = timestampMillis(service?.matchingStartedAt);
  const staleRunning = service?.matchingStatus === 'running' && startedAt > 0
    && nowMs - startedAt >= CONCIERGE_MATCHING_STALE_AFTER_MS;
  const retryingFailedRecovery = service?.matchingStatus === 'failed' && attempts > 0;
  return { context, attempts, retryAt, isRecovery: staleRunning || retryingFailedRecovery };
}

async function claimMatchingWorkerLease({ db, ref, workerLeaseId, requestId = null, nowMs }) {
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.data();
    if (!snapshot.exists || !serviceIsActive(current, nowMs) || !underCap(current)
      || (requestId && (current.proposalRefreshRequestId !== requestId
        || current.proposalRefreshCompletedRequestId === requestId))) return false;
    const workerStarted = timestampMillis(current.proposalRefreshWorkerStartedAt);
    const leaseExpires = timestampMillis(current.proposalRefreshWorkerLeaseExpiresAt)
      || (workerStarted ? workerStarted + WORKER_LEASE_MS : 0);
    if (leaseExpires > nowMs) return false;
    const matchingStarted = timestampMillis(current.matchingStartedAt);
    if (current.matchingStatus === 'running' && matchingStarted > 0
      && nowMs - matchingStarted < CONCIERGE_MATCHING_STALE_AFTER_MS) return false;
    const recovery = staleRecoveryAttempt(current, nowMs);
    if (recovery.isRecovery) {
      if (recovery.attempts >= CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS || recovery.retryAt > nowMs) return false;
      const attempt = recovery.attempts + 1;
      const backoff = CONCIERGE_STALE_RECOVERY_BACKOFF_MS[attempt - 1];
      tx.set(ref, {
        matchingStaleRecoveryContext: recovery.context,
        matchingStaleRecoveryAttempt: attempt,
        matchingStaleRecoveryRetryAt: new Date(nowMs + backoff),
        matchingStaleRecoveryStartedAt: new Date(nowMs),
      }, { merge: true });
    }
    tx.set(ref, {
      proposalRefreshWorkerLeaseId: workerLeaseId,
      proposalRefreshWorkerLeaseExpiresAt: new Date(nowMs + WORKER_LEASE_MS),
      proposalRefreshWorkerStartedAt: new Date(nowMs),
      proposalRefreshWorkerRequestId: requestId,
      proposalRefreshWorkerInputContext: recovery.context,
    }, { merge: true });
    return true;
  });
}

async function noteMatchingRerunAfterLease({ db, ref, requestId = null, nowMs }) {
  return db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current) return false;
    const started = timestampMillis(current?.proposalRefreshWorkerStartedAt);
    const expires = timestampMillis(current?.proposalRefreshWorkerLeaseExpiresAt)
      || (started ? started + WORKER_LEASE_MS : 0);
    const matchingStarted = timestampMillis(current.matchingStartedAt);
    const legacyWorkerActive = current.matchingStatus === 'running' && matchingStarted > 0
      && nowMs - matchingStarted < CONCIERGE_MATCHING_STALE_AFTER_MS;
    const leasedWorkerActive = Boolean(current.proposalRefreshWorkerLeaseId && expires > nowMs);
    if (!leasedWorkerActive && !legacyWorkerActive) return false;
    const inputContext = conciergeMatchingRecoveryContext(current);
    const inputChanged = current.proposalRefreshWorkerInputContext
      && current.proposalRefreshWorkerInputContext !== inputContext;
    const differentRequest = requestId && current.proposalRefreshWorkerRequestId !== requestId;
    if (inputChanged || differentRequest || (legacyWorkerActive && !leasedWorkerActive)) {
      tx.set(ref, {
        proposalRefreshRerunAfterWorker: true,
        proposalRefreshRerunAfterWorkerContext: inputContext,
        proposalRefreshRerunRequestedAt: new Date(nowMs),
      }, { merge: true });
    }
    return true;
  });
}

async function releaseMatchingWorkerLease({ db, ref, workerLeaseId, requestId = null, nowMs = Date.now() }) {
  await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return;
    const inputContext = conciergeMatchingRecoveryContext(current);
    const shouldRerun = current.proposalRefreshRerunAfterWorker === true
      && current.proposalRefreshRerunAfterWorkerContext === inputContext
      && serviceIsActive(current, nowMs) && underCap(current);
    const rerunRequestId = shouldRerun ? randomUUID() : null;
    const patch = {
      proposalRefreshWorkerLeaseId: FieldValue.delete(),
      proposalRefreshWorkerLeaseExpiresAt: FieldValue.delete(),
      proposalRefreshWorkerStartedAt: FieldValue.delete(),
      proposalRefreshWorkerRequestId: FieldValue.delete(),
      proposalRefreshWorkerInputContext: FieldValue.delete(),
      proposalRefreshRerunAfterWorker: FieldValue.delete(),
      proposalRefreshRerunAfterWorkerContext: FieldValue.delete(),
      proposalRefreshRerunRequestedAt: FieldValue.delete(),
      ...(requestId && current?.proposalRefreshClaimId === requestId ? {
        proposalRefreshClaimedAt: FieldValue.delete(),
        proposalRefreshClaimId: FieldValue.delete(),
      } : {}),
      ...(rerunRequestId ? {
        proposalRefreshClaimedAt: new Date(nowMs),
        proposalRefreshClaimId: rerunRequestId,
        proposalRefreshRequestId: rerunRequestId,
        proposalRefreshRequestedBy: 'lifecycle',
      } : {}),
    };
    tx.set(ref, patch, { merge: true });
  });
}

async function clearMatchingRecoveryState({ db, ref, workerLeaseId }) {
  await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return;
    tx.set(ref, {
      matchingStaleRecoveryAttempt: FieldValue.delete(),
      matchingStaleRecoveryContext: FieldValue.delete(),
      matchingStaleRecoveryRetryAt: FieldValue.delete(),
      matchingStaleRecoveryStartedAt: FieldValue.delete(),
      matchingStaleRecoveryExhaustedAt: FieldValue.delete(),
    }, { merge: true });
  });
}

async function reconcileExhaustedStaleMatching(db, ref, nowMs) {
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const service = snapshot.data();
    if (!snapshot.exists || !conciergeStaleRecoveryExhausted(service, nowMs)) return false;
    const workerStarted = timestampMillis(service.proposalRefreshWorkerStartedAt);
    const workerLeaseExpires = timestampMillis(service.proposalRefreshWorkerLeaseExpiresAt)
      || (workerStarted ? workerStarted + WORKER_LEASE_MS : 0);
    if (workerLeaseExpires > nowMs) return false;
    tx.set(ref, {
      matchingStatus: 'failed',
      matchingError: 'stale_worker_retry_exhausted',
      matchingCompletedAt: new Date(nowMs),
      matchingStaleRecoveryExhaustedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    }, { merge: true });
    return true;
  });
}

async function deliverNewProposals({ db, ref, nowMs, send, enrichJobCards }) {
  const snapshot = await ref.get();
  const service = snapshot.data();
  const pending = service?.pendingProposalNotice;
  if (!pending?.key || !serviceIsActive(service, nowMs) || !underCap(service)) return false;
  const snapshots = await Promise.all((pending.proposalIds || []).map(id => ref.collection('proposals').doc(id).get()));
  const proposals = snapshots.filter(s => s.exists && s.data()?.status === 'proposed').map(s => s.data());
  if (!proposals.length) {
    await ref.set({ pendingProposalNotice: FieldValue.delete() }, { merge: true });
    return false;
  }
  const result = await send({ db, recordRef: ref, orderId: ref.id, key: pending.key, audience: 'customer', nowMs,
    eligible: (current) => serviceIsActive(current, Math.max(nowMs, Date.now())) && underCap(current),
    build: async (current, options) => {
      const cardProposals = await enrichJobCards(proposals.slice(0, 3));
      return buildConciergeNewJobsEmail(current, ref.id, [...cardProposals, ...proposals.slice(3)], options);
    },
  });
  if (result.ok || ['already_sent', 'already_ambiguous'].includes(result.reason)) {
    await ref.set({ pendingProposalNotice: FieldValue.delete() }, { merge: true });
  }
  return result.ok;
}

/** One document-trigger worker per service: no user's AI work can starve another service's sweep. */
export async function runConciergeProposalRefresh({ db, serviceId, requestId = null, nowMs = Date.now(), match = runApplicationConciergeMatching, send = sendOrderNotification, deadlineMs = null, enrichJobCards = enrichAssistedApplicationOrders }) {
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const workerLeaseId = randomUUID();
  const claimed = await claimMatchingWorkerLease({ db, ref, workerLeaseId, requestId, nowMs });
  if (!claimed) {
    await noteMatchingRerunAfterLease({ db, ref, requestId, nowMs });
    return { refreshed: 0, newJobEmails: 0 };
  }
  let refreshed = 0;
  try {
    const before = await ref.collection('proposals').get();
    const previouslyProposed = new Set(before.docs.filter(d => d.data().status === 'proposed').map(d => d.id));
    const result = await match({ db, serviceId, ...(deadlineMs ? { deadlineMs } : {}) });
    if (result.status === 'complete') {
      refreshed = 1;
      const after = await ref.collection('proposals').get();
      const ids = after.docs.filter(d => !previouslyProposed.has(d.id)
        && d.data().status === 'proposed' && d.data().eligibilityStatus === 'compatible').map(d => d.id).sort();
      const key = `new_proposals_${createHash('sha256').update(`${ids.join('|')}|${requestId || nowMs}`).digest('hex').slice(0, 24)}`;
      const persisted = await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return false;
        // Persist the consumed event with its notice: Firestore may redeliver a completed request.
        tx.set(ref, {
          ...(requestId ? { proposalRefreshCompletedRequestId: requestId } : {}),
        }, { merge: true });
        if (ids.length && !current?.pendingProposalNotice && serviceIsActive(current, nowMs) && underCap(current)) {
          tx.set(ref, { pendingProposalNotice: { key, proposalIds: ids, createdAt: new Date(nowMs) } }, { merge: true });
        }
        return true;
      });
      if (!persisted) return { refreshed: 0, newJobEmails: 0 };
      await clearMatchingRecoveryState({ db, ref, workerLeaseId });
    } else if (requestId) {
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.proposalRefreshWorkerLeaseId === workerLeaseId) {
          tx.set(ref, { proposalRefreshCompletedRequestId: requestId }, { merge: true });
        }
      });
    }
    return { refreshed, newJobEmails: await deliverNewProposals({ db, ref, nowMs, send, enrichJobCards }) ? 1 : 0 };
  } catch (error) {
    if (requestId) {
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.proposalRefreshWorkerLeaseId === workerLeaseId) {
          tx.set(ref, { proposalRefreshCompletedRequestId: requestId, proposalRefreshLastError: 'matching_failed' }, { merge: true });
        }
      });
    }
    throw error;
  } finally {
    await releaseMatchingWorkerLease({ db, ref, workerLeaseId, requestId, nowMs });
  }
}

/** Serializes the initial CV/location-triggered matcher with lifecycle recovery workers. */
export async function runConciergeMatchingWithLease({ db, serviceId, nowMs = Date.now(), match = runApplicationConciergeMatching, deadlineMs = null }) {
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const workerLeaseId = randomUUID();
  let claimed = await claimMatchingWorkerLease({ db, ref, workerLeaseId, nowMs });
  if (!claimed) {
    const activeWorker = await noteMatchingRerunAfterLease({ db, ref, nowMs });
    if (activeWorker) return { status: 'skipped', reason: 'matching_worker_active' };
    claimed = await claimMatchingWorkerLease({ db, ref, workerLeaseId, nowMs });
    if (!claimed) return { status: 'skipped', reason: 'matching_worker_active' };
  }
  try {
    const result = await match({ db, serviceId, ...(deadlineMs ? { deadlineMs } : {}) });
    if (result?.status === 'complete') await clearMatchingRecoveryState({ db, ref, workerLeaseId });
    return result;
  } finally {
    await releaseMatchingWorkerLease({ db, ref, workerLeaseId, nowMs });
  }
}

export async function runConciergeLifecycleSweep({ db, nowMs = Date.now(), match = runApplicationConciergeMatching, send = sendOrderNotification, unsubscribeSecret = null, enqueueOnly = true, enrichJobCards = enrichAssistedApplicationOrders }) {
  const secret = unsubscribeSecret ?? (await getNewsletterSecrets()).newsletterSecret;
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('paymentStatus', '==', 'paid').get();
  const summary = { queuedRefreshes: 0, refreshed: 0, newJobEmails: 0, renewalEmails: 0, failed: 0 };
  for (const document of snapshot.docs || []) {
    const ref = document.ref;
    try {
      await inheritConciergeRenewalMaterials({ db, serviceId: ref.id, nowMs });
      // Retry a failed notice before a later refresh can replace its pending batch.
      await reconcileExhaustedStaleMatching(db, ref, nowMs);
      if (await deliverNewProposals({ db, ref, nowMs, send, enrichJobCards })) summary.newJobEmails += 1;
      // A rolling deployment must never email lexical-only matches as verified proposals.
      const verifiedMatcherAvailable = match !== runApplicationConciergeMatching || conciergeMatcher.APPLICATION_CONCIERGE_REQUIREMENTS_VERIFIED === true;
      const refreshRequestId = verifiedMatcherAvailable ? await claimRefresh(db, ref, nowMs) : false;
      if (refreshRequestId) {
        if (enqueueOnly) summary.queuedRefreshes += 1;
        else {
          const result = await runConciergeProposalRefresh({ db, serviceId: ref.id, requestId: refreshRequestId, nowMs, match, send, enrichJobCards });
          summary.refreshed += result.refreshed;
          summary.newJobEmails += result.newJobEmails;
        }
      }

      const current = (await ref.get()).data();
      const offer = conciergeRenewalOffer(current, nowMs);
      if (offer?.discounted && secret && current.userId) {
        const result = await send({ db, recordRef: ref, orderId: ref.id, key: `renewal_day_${offer.reminderStage}`, audience: 'customer', nowMs,
          eligible: async (service, tx) => {
            const liveOffer = conciergeRenewalOffer(service, Math.max(nowMs, Date.now()));
            if (!liveOffer?.discounted || liveOffer.reminderStage !== offer.reminderStage || !service.userId) return false;
            const user = await tx.get(db.collection('users').doc(service.userId));
            return user.data()?.applicationConciergePaymentReminder?.optedOut !== true;
          },
          build: (service, options) => buildConciergeRenewalEmail(service, ref.id, { ...options, nowMs: Math.max(nowMs, Date.now()), unsubscribeUrl: paymentReminderUrl(service.userId, secret) }),
        });
        if (result.ok) summary.renewalEmails += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error('[conciergeLifecycle]', ref.id, error?.code || error?.name || 'unknown');
    }
  }
  return summary;
}
