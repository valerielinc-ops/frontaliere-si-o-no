import { createHash, randomUUID } from 'node:crypto';
import { isJobAlertExcluded } from '../../services/emailSuppression.mjs';
import { isAccountDeletedTombstone } from '../../functions/src/authAccountCleanup.js';

export const DISCOVERY_MAX_ATTEMPTS = 3;
export const DISCOVERY_RETRY_MS = 24 * 60 * 60 * 1000;

export function discoveryCanAttempt(subscriber, now = Date.now()) {
  const state = subscriber?.discovery_email;
  if (state == null) return true;
  return state.state === 'failed' && Number.isInteger(state.attempts)
    && state.attempts > 0 && state.attempts < DISCOVERY_MAX_ATTEMPTS
    && Number.isFinite(state.retryAt) && state.retryAt <= now;
}

/** Pending/unknown claims never expire into a second send without reconciliation. */
export async function claimDiscoveryDelivery(db, email, now = Date.now()) {
  const key = String(email || '').trim().toLowerCase();
  const owner = db.collection('job_alert_subscribers').doc(key);
  const ref = owner.collection('delivery_state').doc('first_discovery');
  return db.runTransaction(async (tx) => {
    const ownerSnap = await tx.get(owner);
    const snap = await tx.get(ref); const previous = snap.data()?.discovery;
    if (!ownerSnap.exists || isAccountDeletedTombstone(ownerSnap.data())
      || isJobAlertExcluded(ownerSnap.data()?.status)
      || !discoveryCanAttempt({ discovery_email: previous }, now)) return null;
    const claim = {
      state: 'pending',
      deliveryId: createHash('sha256').update(`job-alert-discovery-v1\0${key}`).digest('hex'),
      attemptId: randomUUID(), attempts: (previous?.attempts || 0) + 1, claimedAt: now,
    };
    tx.set(ref, { discovery: claim }, { mergeFields: ['discovery'] });
    return claim;
  });
}

export function confirmedDiscoveryOutcome(outcome) {
  return outcome?.ambiguousDelivery !== true
    && typeof outcome?.provider === 'string' && outcome.provider.trim().length > 0
    && typeof outcome?.messageId === 'string' && outcome.messageId.trim().length > 0;
}

export function partitionDiscoveryOutcomes(result) {
  const unidentified = result.sent.filter((item) => item.meta?.discoveryClaim && !confirmedDiscoveryOutcome(item));
  const confirmed = result.sent.filter((item) => !unidentified.includes(item));
  const failedItems = result.failed.concat(unidentified.map((item) => ({ ...item, ambiguousDelivery: true, error: 'discovery acknowledgement missing' })));
  return {
    confirmed, failedItems,
    discoveryUnknown: failedItems.filter((item) => item.meta?.discoveryClaim && item.ambiguousDelivery !== false).length,
    // Legacy ambiguous is a subset of provider-accepted targeted sends.
    // Discovery unknown is a separate, unconfirmed category, counted once.
    ambiguous: (result.ambiguous || []).filter((item) => !item.meta?.discoveryClaim).length,
  };
}

export async function finalizeDiscoveryDelivery(db, email, claim, outcome, failed = false, now = Date.now()) {
  if (!claim?.attemptId) return;
  const ref = db.collection('job_alert_subscribers').doc(String(email).trim().toLowerCase())
    .collection('delivery_state').doc('first_discovery');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const current = snap.data()?.discovery;
    if (!snap.exists || current?.attemptId !== claim.attemptId || current.state !== 'pending') return;
    const accepted = !failed && confirmedDiscoveryOutcome(outcome);
    const unknown = !accepted && (!failed || outcome?.ambiguousDelivery !== false);
    tx.set(ref, { discovery: {
      ...current,
      state: accepted ? 'accepted' : unknown ? 'unknown' : 'failed',
      resolvedAt: now,
      ...(accepted ? { provider: outcome.provider, messageId: outcome.messageId } : {}),
      ...(!accepted && !unknown ? { retryAt: now + DISCOVERY_RETRY_MS } : {}),
    } }, { mergeFields: ['discovery'] });
  });
}
