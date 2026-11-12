/** Scheduled lifecycle: refresh active services, deliver new proposals, then offer a renewal on expiry. */
import { inheritConciergeRenewalMaterials } from './applicationConciergeRenewalMaterials.js';
import { getNewsletterSecrets } from './remoteConfigSecrets.js';
import { isApplicationConciergeRenewalEnabledFor } from './applicationConciergeRenewalRollout.js';
import { paymentReminderUrl } from './applicationConciergePaymentReminders.js';
import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, APPLICATION_CONCIERGE_MATCHING_VERSION, acceptedPositionsCount, serviceIsActive, servicePositionLimit, timestampMillis } from './applicationConciergeConstants.js';
import {
  conciergeMatchingRecoveryContext,
  conciergeMatchingVersionRefreshReady,
  conciergeRefreshDue,
  conciergeRenewalOffer,
  conciergeStaleRecoveryExhausted,
  CONCIERGE_MATCHING_STALE_AFTER_MS,
  CONCIERGE_STALE_RECOVERY_BACKOFF_MS,
  CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
} from './applicationConciergeLifecyclePolicy.js';
import * as conciergeMatcher from './applicationConciergeMatching.js';
const { runApplicationConciergeMatching } = conciergeMatcher;
import { proposalAcceptability } from './applicationConciergeCore.js';
import { buildConciergeNewJobsEmail, buildConciergeRenewalEmail } from './applicationConciergeLifecycleEmails.js';
import { customerEmailFor, sendOrderNotification } from './assistedApplicationNotifications.js';
import { enrichAssistedApplicationOrders } from './assistedApplicationJobCard.js';
import {
  conciergeMatchingRuntimeRef,
  mergeConciergeMatchingRuntime,
  updateConciergeMatchingRuntime,
  writeConciergeMatchingRuntime,
} from './applicationConciergeRuntime.js';

const REFRESH_LEASE_MS = 10 * 60 * 1000;
// processApplicationConciergeCv is capped at 540s; never reclaim a live worker before that cap.
const WORKER_LEASE_MS = 10 * 60 * 1000;
function underCap(service) {
  return acceptedPositionsCount(service) < servicePositionLimit(service);
}

export function isFreshConciergeProposalRefreshRequest(before, after) {
  const requestedBy = after?.proposalRefreshRequestedBy;
  return Boolean(
    // A position given back by a withdrawn child (the candidate's, or the employer's withdrawal of the posting).
    (requestedBy === 'lifecycle' || requestedBy === 'candidate_withdrawal' || requestedBy === 'employer_withdrawal')
      && after?.proposalRefreshRequestId
      && after.proposalRefreshRequestId !== before?.proposalRefreshRequestId,
  );
}

/** Defer event-driven full scans to the bounded lifecycle sweep. */
export async function queueConciergeMatchingRefresh({ db, serviceId, nowMs = Date.now() }) {
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  return db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyService = snapshot.data() || {};
    const service = mergeConciergeMatchingRuntime(legacyService, runtimeSnapshot.data() || null);
    if (!snapshot.exists || !serviceIsActive(service, nowMs) || !service?.cvStorageKey
      || timestampMillis(service.consentedAt) <= 0 || !underCap(service)) return false;
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtimeSnapshot.data() || null, {
      matchingEventRefreshRequestedAt: new Date(nowMs),
    });
    return true;
  });
}

async function claimRefresh(db, ref, nowMs) {
  const requestId = randomUUID();
  return db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyService = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    if (!snapshot.exists || service?.pendingProposalNotice || !conciergeRefreshDue(service, nowMs)) return false;
    const versionMismatch = service.matchingStatus === 'complete'
      && service.matchingVersion !== APPLICATION_CONCIERGE_MATCHING_VERSION;
    if (versionMismatch && !conciergeMatchingVersionRefreshReady(service, nowMs)) {
      const observedVersion = String(service.matchingVersionRefreshVersion || '');
      const observedAt = timestampMillis(service.matchingVersionRefreshObservedAt);
      if (observedVersion !== APPLICATION_CONCIERGE_MATCHING_VERSION || observedAt <= 0) {
        tx.set(ref, {
          matchingVersionRefreshVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
          matchingVersionRefreshObservedAt: new Date(nowMs),
        }, { merge: true });
      }
      return false;
    }
    const claimed = timestampMillis(service.proposalRefreshClaimedAt);
    if (claimed && nowMs - claimed < REFRESH_LEASE_MS) return false;
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, {
      proposalRefreshClaimedAt: new Date(nowMs),
      proposalRefreshClaimId: requestId,
      matchingEventRefreshRequestedAt: FieldValue.delete(),
      proposalRefreshRerunAfterWorker: FieldValue.delete(),
      proposalRefreshRerunAfterWorkerContext: FieldValue.delete(),
      proposalRefreshRerunRequestedAt: FieldValue.delete(),
    });
    tx.set(ref, {
      proposalRefreshRequestId: requestId,
      proposalRefreshRequestedBy: 'lifecycle',
      matchingVersionRefreshVersion: FieldValue.delete(),
      matchingVersionRefreshObservedAt: FieldValue.delete(),
    }, { merge: true });
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
  const failedRunRecovery = service?.matchingStatus === 'failed';
  return { context, attempts, retryAt, isRecovery: staleRunning || failedRunRecovery };
}

async function claimMatchingWorkerLease({ db, ref, workerLeaseId, requestId = null, nowMs }) {
  return db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyCurrent = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const current = mergeConciergeMatchingRuntime(legacyCurrent, runtime);
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
    const runtimePatch = {
      proposalRefreshWorkerLeaseId: workerLeaseId,
      proposalRefreshWorkerLeaseExpiresAt: new Date(nowMs + WORKER_LEASE_MS),
      proposalRefreshWorkerStartedAt: new Date(nowMs),
      proposalRefreshWorkerRequestId: requestId,
      proposalRefreshWorkerInputContext: recovery.context,
    };
    if (recovery.isRecovery) {
      if (recovery.attempts >= CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS || recovery.retryAt > nowMs) return false;
      const attempt = recovery.attempts + 1;
      const backoff = CONCIERGE_STALE_RECOVERY_BACKOFF_MS[attempt - 1];
      Object.assign(runtimePatch, {
        matchingStaleRecoveryContext: recovery.context,
        matchingStaleRecoveryAttempt: attempt,
        matchingStaleRecoveryRetryAt: new Date(nowMs + backoff),
        matchingStaleRecoveryStartedAt: new Date(nowMs),
      });
    }
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyCurrent, runtime, runtimePatch);
    return true;
  });
}

async function noteMatchingRerunAfterLease({ db, ref, requestId = null, nowMs }) {
  return db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyCurrent = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const current = mergeConciergeMatchingRuntime(legacyCurrent, runtime);
    if (!snapshot.exists) return false;
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
      writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyCurrent, runtime, {
        proposalRefreshRerunAfterWorker: true,
        proposalRefreshRerunAfterWorkerContext: inputContext,
        proposalRefreshRerunRequestedAt: new Date(nowMs),
      });
    }
    return true;
  });
}

async function releaseMatchingWorkerLease({ db, ref, workerLeaseId, requestId = null, nowMs = Date.now() }) {
  await db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyCurrent = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const current = mergeConciergeMatchingRuntime(legacyCurrent, runtime);
    if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return;
    const inputContext = conciergeMatchingRecoveryContext(current);
    const shouldRerun = current.proposalRefreshRerunAfterWorker === true
      && current.proposalRefreshRerunAfterWorkerContext === inputContext
      && serviceIsActive(current, nowMs) && underCap(current);
    const rerunRequestId = shouldRerun ? randomUUID() : null;
    const runtimePatch = {
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
      } : {}),
    };
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyCurrent, runtime, runtimePatch);
    if (rerunRequestId) {
      tx.set(ref, {
        proposalRefreshRequestId: rerunRequestId,
        proposalRefreshRequestedBy: 'lifecycle',
      }, { merge: true });
    }
  });
}

async function clearMatchingRecoveryState({ db, ref, workerLeaseId }) {
  await db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyCurrent = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const current = mergeConciergeMatchingRuntime(legacyCurrent, runtime);
    if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return;
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyCurrent, runtime, {
      matchingStaleRecoveryAttempt: FieldValue.delete(),
      matchingStaleRecoveryContext: FieldValue.delete(),
      matchingStaleRecoveryRetryAt: FieldValue.delete(),
      matchingStaleRecoveryStartedAt: FieldValue.delete(),
      matchingStaleRecoveryExhaustedAt: FieldValue.delete(),
    });
  });
}

async function reconcileExhaustedStaleMatching(db, ref, nowMs) {
  return db.runTransaction(async tx => {
    const runtimeRef = conciergeMatchingRuntimeRef(ref);
    const [snapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
    const legacyService = snapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    if (!snapshot.exists || !conciergeStaleRecoveryExhausted(service, nowMs)) return false;
    const workerStarted = timestampMillis(service.proposalRefreshWorkerStartedAt);
    const workerLeaseExpires = timestampMillis(service.proposalRefreshWorkerLeaseExpiresAt)
      || (workerStarted ? workerStarted + WORKER_LEASE_MS : 0);
    if (workerLeaseExpires > nowMs) return false;
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, {
      matchingStaleRecoveryExhaustedAt: new Date(nowMs),
      matchingRunStatus: FieldValue.delete(),
      matchingStartedAt: FieldValue.delete(),
    });
    tx.set(ref, {
      matchingStatus: 'failed',
      matchingError: service.matchingStatus === 'running'
        ? 'stale_worker_retry_exhausted'
        : service.matchingError || 'matching_retry_exhausted',
      matchingCompletedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    }, { merge: true });
    return true;
  });
}

function proposalNoticeRecipientHash(service, serviceId) {
  const recipient = customerEmailFor(service);
  return recipient ? createHash('sha256').update(`${serviceId || ''}|${recipient}`).digest('hex').slice(0, 24) : '';
}

function proposalNoticeRecipientHashFromAddress(value, serviceId) {
  const recipient = customerEmailFor({ applicantEmail: value });
  return recipient ? createHash('sha256').update(`${serviceId || ''}|${recipient}`).digest('hex').slice(0, 24) : '';
}

function proposalNoticeKey(ids, proposals, salt = '', recipientHash = '') {
  const epoch = ids.map(id => `${id}:${timestampMillis(proposals.get(id)?.eligibilityAcceptableSince)}`).sort().join('|');
  return `new_proposals_${createHash('sha256').update(`${epoch}|${salt}|${recipientHash}`).digest('hex').slice(0, 24)}`;
}

function pendingNoticeCanMoveToRecipient(service, pending, recipientHash, serviceId) {
  if (!pending?.recipientHash || !recipientHash || pending.recipientHash === recipientHash) return false;
  const notification = service.notifications?.[pending.key] || null;
  if (!notification) return true;
  if (notification.deliveryStatus === 'bounced') {
    const attemptedHash = proposalNoticeRecipientHashFromAddress(notification.to, serviceId) || pending.recipientHash;
    return Boolean(attemptedHash && attemptedHash !== recipientHash);
  }
  return notification.status === 'failed'
    && notification.providerStatus !== 'accepted'
    && notification.providerAcceptedAt == null
    && !['delivered', 'bounced', 'complained'].includes(notification.deliveryStatus);
}

function proposalNoticeAttemptRecipientHash(service, key, recipientHashHint, serviceId) {
  return proposalNoticeRecipientHashFromAddress(service.notifications?.[key]?.to, serviceId)
    || recipientHashHint || '';
}

/** Persist each acceptable proposal's own clock and queue one idempotent notice. */
async function reconcileProposalAcceptability({ db, ref, nowMs, priorAcceptability = null }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  const [snapshot, proposalSnapshot] = await Promise.all([
    ref.get(), ref.collection('proposals').where('status', '==', 'proposed').get(),
  ]);
  if (!snapshot.exists) return;
  const proposalRefs = proposalSnapshot.docs || [];
  await db.runTransaction(async tx => {
    const [currentServiceSnapshot, currentRuntimeSnapshot, ...currentProposalSnapshots] = await Promise.all([
      tx.get(ref), tx.get(runtimeRef), ...proposalRefs.map(doc => tx.get(doc.ref || doc)),
    ]);
    if (!currentServiceSnapshot.exists) return;
    const legacyService = currentServiceSnapshot.data() || {};
    const runtime = currentRuntimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    const changes = [];
    const missingNoticeIds = [];
    const proposalsById = new Map();
    const clockAt = new Date(Math.max(Number(nowMs) || 0, Date.now()));
    const recipientHash = proposalNoticeRecipientHash(service, ref.id);
    for (let index = 0; index < currentProposalSnapshots.length; index += 1) {
      const currentSnapshot = currentProposalSnapshots[index];
      if (!currentSnapshot.exists) continue;
      let proposal = currentSnapshot.data() || {};
      if (proposal.status !== 'proposed') continue;
      const id = proposalRefs[index].id;
      const decision = proposalAcceptability(service, proposal, runtime);
      const previousWasAcceptable = priorAcceptability?.get(id);
      let noticePatch = null;
      const previousNotification = proposal.proposalNoticeKey
        ? service.notifications?.[proposal.proposalNoticeKey] || null
        : null;
      const providerDeliveryStatus = previousNotification?.deliveryStatus;
      const attemptedRecipientHash = proposal.proposalNoticeRecipientHash
        || proposalNoticeRecipientHashFromAddress(previousNotification?.to, ref.id);
      const bouncedToCorrectedAddress = (providerDeliveryStatus === 'bounced'
          || (proposal.proposalNoticeStatus === 'undeliverable' && proposal.proposalNoticeFailureReason === 'bounced'))
        && Boolean(attemptedRecipientHash && recipientHash && attemptedRecipientHash !== recipientHash);
      if (bouncedToCorrectedAddress) {
        noticePatch = {
          proposalNoticeSentAt: FieldValue.delete(),
          proposalNoticeStatus: FieldValue.delete(),
          proposalNoticeUnknownAt: FieldValue.delete(),
          proposalNoticeUndeliverableAt: FieldValue.delete(),
          proposalNoticeFailureReason: FieldValue.delete(),
          proposalNoticeKey: FieldValue.delete(),
          proposalNoticeRecipientHash: FieldValue.delete(),
        };
        proposal = { ...proposal, proposalNoticeSentAt: null, proposalNoticeStatus: null,
          proposalNoticeUnknownAt: null, proposalNoticeUndeliverableAt: null,
          proposalNoticeFailureReason: null, proposalNoticeKey: null, proposalNoticeRecipientHash: null };
      } else if (providerDeliveryStatus === 'delivered') {
        const deliveredAt = timestampMillis(previousNotification?.providerAcceptedAt)
          || timestampMillis(previousNotification?.sentAt)
          || timestampMillis(previousNotification?.deliveredAt)
          || clockAt.getTime();
        noticePatch = {
          proposalNoticeSentAt: new Date(deliveredAt),
          proposalNoticeStatus: 'sent',
          proposalNoticeUnknownAt: FieldValue.delete(),
          proposalNoticeUndeliverableAt: FieldValue.delete(),
          proposalNoticeFailureReason: FieldValue.delete(),
          proposalNoticeKey: proposal.proposalNoticeKey,
          proposalNoticeRecipientHash: attemptedRecipientHash || recipientHash || null,
        };
        proposal = { ...proposal, proposalNoticeSentAt: new Date(deliveredAt), proposalNoticeStatus: 'sent',
          proposalNoticeUnknownAt: null, proposalNoticeUndeliverableAt: null, proposalNoticeFailureReason: null,
          proposalNoticeRecipientHash: attemptedRecipientHash || recipientHash || null };
      } else if (providerDeliveryStatus === 'bounced' || providerDeliveryStatus === 'complained') {
        const failedAt = timestampMillis(providerDeliveryStatus === 'bounced'
          ? previousNotification?.bouncedAt
          : previousNotification?.complainedAt) || clockAt.getTime();
        noticePatch = {
          proposalNoticeSentAt: FieldValue.delete(),
          proposalNoticeStatus: 'undeliverable',
          proposalNoticeUndeliverableAt: timestampMillis(proposal.proposalNoticeUndeliverableAt)
            ? proposal.proposalNoticeUndeliverableAt : new Date(failedAt),
          proposalNoticeFailureReason: providerDeliveryStatus,
          proposalNoticeKey: proposal.proposalNoticeKey,
          proposalNoticeRecipientHash: attemptedRecipientHash || recipientHash || null,
        };
        proposal = { ...proposal, proposalNoticeSentAt: null, proposalNoticeUnknownAt: null, proposalNoticeStatus: 'undeliverable',
          proposalNoticeUndeliverableAt: noticePatch.proposalNoticeUndeliverableAt,
          proposalNoticeFailureReason: providerDeliveryStatus,
          proposalNoticeRecipientHash: attemptedRecipientHash || recipientHash || null };
      }
      if (!decision.acceptable) {
        const noticeOutcomeTerminal = ['unknown', 'undeliverable'].includes(proposal.proposalNoticeStatus)
          || proposal.proposalNoticeUnknownAt != null || proposal.proposalNoticeUndeliverableAt != null;
        if (proposal.eligibilityAcceptableSince != null || proposal.proposalNoticeSentAt != null
          || (!noticeOutcomeTerminal && (proposal.proposalNoticeStatus != null || proposal.proposalNoticeUnknownAt != null
            || proposal.proposalNoticeUndeliverableAt != null))) {
          changes.push({ ref: currentSnapshot.ref || proposalRefs[index].ref, patch: {
            ...(noticePatch || {}),
            eligibilityAcceptableSince: FieldValue.delete(),
            proposalNoticeSentAt: FieldValue.delete(),
            ...(!noticeOutcomeTerminal ? {
              proposalNoticeStatus: FieldValue.delete(),
              proposalNoticeUnknownAt: FieldValue.delete(),
              proposalNoticeUndeliverableAt: FieldValue.delete(),
              proposalNoticeFailureReason: FieldValue.delete(),
              proposalNoticeKey: FieldValue.delete(),
              proposalNoticeRecipientHash: FieldValue.delete(),
            } : {}),
          } });
        } else if (noticePatch) {
          changes.push({ ref: currentSnapshot.ref || proposalRefs[index].ref, patch: noticePatch });
        }
        continue;
      }
      const newEligibilityWindow = previousWasAcceptable === false;
      const needsAnchor = !timestampMillis(proposal.eligibilityAcceptableSince) || newEligibilityWindow;
      const canResetNotice = newEligibilityWindow
        && !['unknown', 'undeliverable'].includes(proposal.proposalNoticeStatus)
        && proposal.proposalNoticeUnknownAt == null && proposal.proposalNoticeUndeliverableAt == null;
      const eligibilityPatch = needsAnchor ? {
        eligibilityAcceptableSince: clockAt,
        ...(canResetNotice ? {
          proposalNoticeSentAt: FieldValue.delete(),
          proposalNoticeStatus: FieldValue.delete(),
          proposalNoticeUnknownAt: FieldValue.delete(),
          proposalNoticeUndeliverableAt: FieldValue.delete(),
          proposalNoticeFailureReason: FieldValue.delete(),
          proposalNoticeKey: FieldValue.delete(),
          proposalNoticeRecipientHash: FieldValue.delete(),
        } : {}),
      } : null;
      const patch = noticePatch || eligibilityPatch
        ? { ...(noticePatch || {}), ...(eligibilityPatch || {}) }
        : null;
      if (patch) changes.push({ ref: currentSnapshot.ref || proposalRefs[index].ref, patch });
      const currentProposal = {
        ...proposal,
        ...(eligibilityPatch || {}),
        ...(needsAnchor ? { eligibilityAcceptableSince: clockAt } : {}),
        ...(canResetNotice ? { proposalNoticeSentAt: null, proposalNoticeStatus: null, proposalNoticeUnknownAt: null,
          proposalNoticeUndeliverableAt: null, proposalNoticeFailureReason: null, proposalNoticeKey: null,
          proposalNoticeRecipientHash: null } : {}),
      };
      proposalsById.set(id, currentProposal);
      if (!timestampMillis(currentProposal.proposalNoticeSentAt)
        && !['unknown', 'undeliverable'].includes(currentProposal.proposalNoticeStatus)
        && currentProposal.proposalNoticeUnknownAt == null && currentProposal.proposalNoticeUndeliverableAt == null) {
        missingNoticeIds.push(id);
      }
    }
    for (const change of changes) tx.set(change.ref, change.patch, { merge: true });
    const current = mergeConciergeMatchingRuntime(legacyService, runtime);
    const currentPending = current.pendingProposalNotice || null;
    const movePending = pendingNoticeCanMoveToRecipient(current, currentPending, recipientHash, ref.id);
    if ((missingNoticeIds.length && (!currentPending || movePending)) || (currentPending && movePending)) {
      const ids = missingNoticeIds.sort();
      const nextPending = ids.length && serviceIsActive(service, nowMs) && underCap(service)
        ? { key: proposalNoticeKey(ids, proposalsById, 'availability', recipientHash), proposalIds: ids,
          createdAt: clockAt, recipientHash }
        : FieldValue.delete();
      writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, { pendingProposalNotice: nextPending });
    }
  });
}

async function markProposalNoticeSent({ db, ref, proposalIds, key, recipientHashHint = null, nowMs }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  const proposalRefs = proposalIds.map(id => ref.collection('proposals').doc(id));
  return db.runTransaction(async tx => {
    const [serviceSnapshot, runtimeSnapshot, ...proposalSnapshots] = await Promise.all([
      tx.get(ref), tx.get(runtimeRef), ...proposalRefs.map(proposalRef => tx.get(proposalRef)),
    ]);
    const legacyService = serviceSnapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    const notice = service.notifications?.[key] || null;
    const sentAtMs = timestampMillis(notice?.providerAcceptedAt)
      || timestampMillis(notice?.sentAt)
      || Number(nowMs) || Date.now();
    const sentAt = new Date(sentAtMs);
    const recipientHash = proposalNoticeAttemptRecipientHash(service, key, recipientHashHint, ref.id);
    const written = [];
    for (let index = 0; index < proposalSnapshots.length; index += 1) {
      const proposalSnapshot = proposalSnapshots[index];
      const proposal = proposalSnapshot.data() || {};
      if (proposalSnapshot.exists && proposal.status === 'proposed'
        && proposalAcceptability(service, proposal, runtime).acceptable) {
        tx.set(proposalRefs[index], {
          proposalNoticeSentAt: sentAt, proposalNoticeStatus: 'sent',
          proposalNoticeUnknownAt: FieldValue.delete(), proposalNoticeUndeliverableAt: FieldValue.delete(),
          proposalNoticeFailureReason: FieldValue.delete(), proposalNoticeKey: key,
          proposalNoticeRecipientHash: recipientHash || null,
        }, { merge: true });
        written.push(proposalIds[index]);
      }
    }
    return written;
  });
}

async function markProposalNoticeUnknown({ db, ref, proposalIds, key, recipientHashHint = null, nowMs }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  const proposalRefs = proposalIds.map(id => ref.collection('proposals').doc(id));
  const unknownAt = new Date(Math.max(Number(nowMs) || 0, Date.now()));
  return db.runTransaction(async tx => {
    const [serviceSnapshot, runtimeSnapshot, ...proposalSnapshots] = await Promise.all([
      tx.get(ref), tx.get(runtimeRef), ...proposalRefs.map(proposalRef => tx.get(proposalRef)),
    ]);
    const legacyService = serviceSnapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    const recipientHash = proposalNoticeAttemptRecipientHash(service, key, recipientHashHint, ref.id);
    const written = [];
    for (let index = 0; index < proposalSnapshots.length; index += 1) {
      const proposalSnapshot = proposalSnapshots[index];
      const proposal = proposalSnapshot.data() || {};
      if (proposalSnapshot.exists && proposal.status === 'proposed'
        && proposalAcceptability(service, proposal, runtime).acceptable) {
        tx.set(proposalRefs[index], {
          proposalNoticeSentAt: FieldValue.delete(),
          proposalNoticeStatus: 'unknown',
          proposalNoticeUnknownAt: unknownAt,
          proposalNoticeFailureReason: FieldValue.delete(),
          proposalNoticeKey: key,
          proposalNoticeRecipientHash: recipientHash || null,
        }, { merge: true });
        written.push(proposalIds[index]);
      }
    }
    return written;
  });
}

async function markProposalNoticeUndeliverable({ db, ref, proposalIds, key, recipientHashHint = null, reason, nowMs }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  const proposalRefs = proposalIds.map(id => ref.collection('proposals').doc(id));
  const failedAt = new Date(Math.max(Number(nowMs) || 0, Date.now()));
  return db.runTransaction(async tx => {
    const [serviceSnapshot, runtimeSnapshot, ...proposalSnapshots] = await Promise.all([
      tx.get(ref), tx.get(runtimeRef), ...proposalRefs.map(proposalRef => tx.get(proposalRef)),
    ]);
    const legacyService = serviceSnapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    const recipientHash = proposalNoticeAttemptRecipientHash(service, key, recipientHashHint, ref.id);
    const written = [];
    for (let index = 0; index < proposalSnapshots.length; index += 1) {
      const proposalSnapshot = proposalSnapshots[index];
      const proposal = proposalSnapshot.data() || {};
      if (proposalSnapshot.exists && proposal.status === 'proposed'
        && proposalAcceptability(service, proposal, runtime).acceptable) {
        tx.set(proposalRefs[index], {
          proposalNoticeSentAt: FieldValue.delete(),
          proposalNoticeStatus: 'undeliverable',
          proposalNoticeUndeliverableAt: failedAt,
          proposalNoticeFailureReason: reason,
          proposalNoticeKey: key,
          proposalNoticeRecipientHash: recipientHash || null,
        }, { merge: true });
        written.push(proposalIds[index]);
      }
    }
    return written;
  });
}

async function settlePendingProposalNotice({ db, ref, pending, settledIds }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  return db.runTransaction(async tx => {
    const [serviceSnapshot, runtimeSnapshot, ...proposalSnapshots] = await Promise.all([
      tx.get(ref), tx.get(runtimeRef), ...(pending.proposalIds || []).map(id => tx.get(ref.collection('proposals').doc(id))),
    ]);
    const legacyService = serviceSnapshot.data() || {};
    const runtime = runtimeSnapshot.data() || null;
    const current = mergeConciergeMatchingRuntime(legacyService, runtime);
    if (current.pendingProposalNotice?.key !== pending.key) return;
    const service = mergeConciergeMatchingRuntime(legacyService, runtime);
    const keep = [];
    for (let index = 0; index < (pending.proposalIds || []).length; index += 1) {
      if (settledIds.has(pending.proposalIds[index])) continue;
      const proposal = proposalSnapshots[index].data() || {};
      if (proposalSnapshots[index].exists && proposal.status === 'proposed'
        && proposalAcceptability(service, proposal, runtime).acceptable) keep.push(pending.proposalIds[index]);
    }
    const patch = keep.length
      ? { pendingProposalNotice: { ...pending, proposalIds: keep } }
      : { pendingProposalNotice: FieldValue.delete() };
    writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, patch);
  });
}

async function deliverNewProposals({ db, ref, nowMs, send, enrichJobCards }) {
  const runtimeRef = conciergeMatchingRuntimeRef(ref);
  const [snapshot, runtimeSnapshot] = await Promise.all([ref.get(), runtimeRef.get()]);
  const runtime = runtimeSnapshot.data() || null;
  const service = mergeConciergeMatchingRuntime(snapshot.data() || {}, runtime);
  const pending = service?.pendingProposalNotice;
  if (!pending?.key || !serviceIsActive(service, nowMs) || !underCap(service)) return false;
  const snapshots = await Promise.all((pending.proposalIds || []).map(id => ref.collection('proposals').doc(id).get()));
  const currentProposals = snapshots.map((s, index) => ({ snapshot: s, id: pending.proposalIds[index], data: s.data() || {} }));
  const proposals = currentProposals.filter(({ snapshot: proposalSnapshot, data }) => proposalSnapshot.exists
    && data.status === 'proposed' && proposalAcceptability(service, data, runtime).acceptable).map(({ data }) => data);
  const proposalIds = currentProposals.filter(({ snapshot: proposalSnapshot, data }) => proposalSnapshot.exists
    && data.status === 'proposed' && proposalAcceptability(service, data, runtime).acceptable).map(({ id }) => id);
  if (!proposals.length) {
    await settlePendingProposalNotice({ db, ref, pending, settledIds: new Set() });
    return false;
  }
  const currentProposalIds = new Set(proposalIds);
  const serviceRuntimeRef = conciergeMatchingRuntimeRef(ref);
  const noticeRecipientHash = pending.recipientHash || proposalNoticeRecipientHash(service, ref.id);
  let proposalsAtClaim = proposals;
  const result = await send({ db, recordRef: ref, orderId: ref.id, key: pending.key, audience: 'customer', nowMs,
    trackingTarget: { kind: 'application-concierge', id: ref.id },
    eligible: async (current, tx) => {
      if (!serviceIsActive(current, Math.max(nowMs, Date.now())) || !underCap(current)) return false;
      const [runtimeSnapshot, ...proposalSnapshots] = await Promise.all([
        tx.get(serviceRuntimeRef), ...proposalIds.map(id => tx.get(ref.collection('proposals').doc(id))),
      ]);
      const runtimeNow = runtimeSnapshot.data() || null;
      const serviceNow = mergeConciergeMatchingRuntime(current, runtimeNow);
      const currentRecipientHash = proposalNoticeRecipientHash(serviceNow, ref.id);
      const previousAttempt = serviceNow.notifications?.[pending.key] || null;
      const previousAttemptCanOnlySettle = Boolean(previousAttempt && (
        ['sending', 'sent', 'ambiguous'].includes(previousAttempt.status)
        || previousAttempt.providerStatus === 'accepted'
        || ['delivered', 'bounced', 'complained'].includes(previousAttempt.deliveryStatus)
      ));
      if (currentRecipientHash !== noticeRecipientHash && !previousAttemptCanOnlySettle) return false;
      const currentProposals = proposalSnapshots.map(snapshot => snapshot.data() || {});
      const allAcceptable = proposalSnapshots.length === proposalIds.length && proposalSnapshots.every(proposalSnapshot =>
        proposalSnapshot.exists && proposalAcceptability(serviceNow, proposalSnapshot.data() || {}, runtimeNow).acceptable);
      if (allAcceptable) proposalsAtClaim = currentProposals;
      return allAcceptable;
    },
    build: async (current, options) => {
      const cardProposals = await enrichJobCards(proposalsAtClaim.slice(0, 3));
      return buildConciergeNewJobsEmail(current, ref.id, [...cardProposals, ...proposalsAtClaim.slice(3)], options);
    },
  });
  const alreadyDelivered = result.reason === 'already_delivered';
  const alreadySent = result.reason === 'already_sent';
  const terminalNonDelivery = ['already_bounced', 'already_complained'].includes(result.reason);
  const ambiguousOutcome = ['already_ambiguous', 'stale_send_outcome_unknown'].includes(result.reason);
  if (result.ok || alreadySent || alreadyDelivered) {
    await markProposalNoticeSent({ db, ref, proposalIds: [...currentProposalIds], key: pending.key,
      recipientHashHint: pending.recipientHash || null, nowMs });
  } else if (ambiguousOutcome) {
    await markProposalNoticeUnknown({ db, ref, proposalIds: [...currentProposalIds], key: pending.key,
      recipientHashHint: pending.recipientHash || null, nowMs });
  } else if (terminalNonDelivery) {
    await markProposalNoticeUndeliverable({ db, ref, proposalIds: [...currentProposalIds], key: pending.key,
      recipientHashHint: pending.recipientHash || null,
      reason: result.reason === 'already_bounced' ? 'bounced' : 'complained', nowMs });
  }
  const settledIds = result.ok || alreadySent || alreadyDelivered || terminalNonDelivery || ambiguousOutcome
    ? currentProposalIds : new Set();
  await settlePendingProposalNotice({ db, ref, pending, settledIds });
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
    const [beforeServiceSnapshot, beforeRuntimeSnapshot, before] = await Promise.all([
      ref.get(), conciergeMatchingRuntimeRef(ref).get(), ref.collection('proposals').get(),
    ]);
    const beforeRuntime = beforeRuntimeSnapshot.data() || null;
    const beforeService = mergeConciergeMatchingRuntime(beforeServiceSnapshot.data() || {}, beforeRuntime);
    const priorAcceptability = new Map((before.docs || []).map(doc => [doc.id,
      proposalAcceptability(beforeService, doc.data() || {}, beforeRuntime).acceptable]));
    const result = await match({ db, serviceId, ...(deadlineMs ? { deadlineMs } : {}) });
    if (result.status === 'complete') {
      refreshed = 1;
      await reconcileProposalAcceptability({ db, ref, nowMs, priorAcceptability });
      const persisted = await db.runTransaction(async tx => {
        const runtimeRef = conciergeMatchingRuntimeRef(ref);
        const [serviceSnapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
        const legacyService = serviceSnapshot.data() || {};
        const runtime = runtimeSnapshot.data() || null;
        const current = mergeConciergeMatchingRuntime(legacyService, runtime);
        if (current?.proposalRefreshWorkerLeaseId !== workerLeaseId) return false;
        // Persist the consumed event with its notice: Firestore may redeliver a completed request.
        const runtimePatch = {
          ...(requestId ? { proposalRefreshCompletedRequestId: requestId } : {}),
          proposalRefreshLastError: FieldValue.delete(),
        };
        if (Object.keys(runtimePatch).length) writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, runtimePatch);
        return true;
      });
      if (!persisted) return { refreshed: 0, newJobEmails: 0 };
      await clearMatchingRecoveryState({ db, ref, workerLeaseId });
    } else if (requestId) {
      await db.runTransaction(async tx => {
        const runtimeRef = conciergeMatchingRuntimeRef(ref);
        const [serviceSnapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
        const legacyService = serviceSnapshot.data() || {};
        const runtime = runtimeSnapshot.data() || null;
        const current = mergeConciergeMatchingRuntime(legacyService, runtime);
        if (current?.proposalRefreshWorkerLeaseId === workerLeaseId) {
          writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, {
            proposalRefreshCompletedRequestId: requestId,
          });
        }
      });
    }
    return { refreshed, newJobEmails: await deliverNewProposals({ db, ref, nowMs, send, enrichJobCards }) ? 1 : 0 };
  } catch (error) {
    if (requestId) {
      await db.runTransaction(async tx => {
        const runtimeRef = conciergeMatchingRuntimeRef(ref);
        const [serviceSnapshot, runtimeSnapshot] = await Promise.all([tx.get(ref), tx.get(runtimeRef)]);
        const legacyService = serviceSnapshot.data() || {};
        const runtime = runtimeSnapshot.data() || null;
        const current = mergeConciergeMatchingRuntime(legacyService, runtime);
        if (current?.proposalRefreshWorkerLeaseId === workerLeaseId) {
          writeConciergeMatchingRuntime(tx, ref, runtimeRef, legacyService, runtime, {
            proposalRefreshCompletedRequestId: requestId,
            proposalRefreshLastError: 'matching_failed',
          });
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
    const [serviceSnapshot, runtimeSnapshot, proposalsSnapshot] = await Promise.all([
      ref.get(), conciergeMatchingRuntimeRef(ref).get(), ref.collection('proposals').get(),
    ]);
    const runtime = runtimeSnapshot.data() || null;
    const service = mergeConciergeMatchingRuntime(serviceSnapshot.data() || {}, runtime);
    const priorAcceptability = new Map((proposalsSnapshot.docs || []).map(doc => [doc.id,
      proposalAcceptability(service, doc.data() || {}, runtime).acceptable]));
    const result = await match({ db, serviceId, ...(deadlineMs ? { deadlineMs } : {}) });
    if (result?.status === 'complete') {
      await reconcileProposalAcceptability({ db, ref, nowMs, priorAcceptability });
      await clearMatchingRecoveryState({ db, ref, workerLeaseId });
    }
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
      await reconcileProposalAcceptability({ db, ref, nowMs });
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
      const renewalEnabled = current.userId && await isApplicationConciergeRenewalEnabledFor(current.userId);
      if (offer?.discounted && secret && renewalEnabled) {
        const result = await send({ db, recordRef: ref, orderId: ref.id, key: `renewal_day_${offer.reminderStage}`, audience: 'customer', nowMs,
          trackingTarget: { kind: 'application-concierge', id: ref.id },
          eligible: async (service, tx) => {
            const liveOffer = conciergeRenewalOffer(service, Math.max(nowMs, Date.now()));
            if (!liveOffer?.discounted || liveOffer.reminderStage !== offer.reminderStage || !service.userId
              || !await isApplicationConciergeRenewalEnabledFor(service.userId)) return false;
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
