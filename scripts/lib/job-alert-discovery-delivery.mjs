import { createHash, randomUUID } from 'node:crypto';

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
  const ref = db.collection('job_alert_subscribers').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const data = snap.data() || {};
    if (!snap.exists || !discoveryCanAttempt(data, now)) return null;
    const previous = data.discovery_email;
    const claim = {
      state: 'pending',
      deliveryId: createHash('sha256').update(`job-alert-discovery-v1\0${key}`).digest('hex'),
      attemptId: randomUUID(), attempts: (previous?.attempts || 0) + 1, claimedAt: now,
    };
    tx.set(ref, { discovery_email: claim }, { merge: true });
    return claim;
  });
}

export function confirmedDiscoveryOutcome(outcome) {
  return outcome?.ambiguousDelivery !== true
    && typeof outcome?.provider === 'string' && outcome.provider.trim().length > 0
    && typeof outcome?.messageId === 'string' && outcome.messageId.trim().length > 0;
}

export async function finalizeDiscoveryDelivery(db, email, claim, outcome, failed = false, now = Date.now()) {
  if (!claim?.attemptId) return;
  const ref = db.collection('job_alert_subscribers').doc(String(email).trim().toLowerCase());
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const current = snap.data()?.discovery_email;
    if (!snap.exists || current?.attemptId !== claim.attemptId || current.state !== 'pending') return;
    const accepted = !failed && confirmedDiscoveryOutcome(outcome);
    const unknown = !accepted && (!failed || outcome?.ambiguousDelivery === true);
    tx.set(ref, { discovery_email: {
      ...current,
      state: accepted ? 'accepted' : unknown ? 'unknown' : 'failed',
      resolvedAt: now,
      ...(accepted ? { provider: outcome.provider, messageId: outcome.messageId } : {}),
      ...(!accepted && !unknown ? { retryAt: now + DISCOVERY_RETRY_MS } : {}),
    } }, { merge: true });
  });
}
