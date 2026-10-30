/** Scheduled lifecycle: refresh active services, deliver new proposals, then offer a renewal on expiry. */
import { inheritConciergeRenewalMaterials } from './applicationConciergeRenewalMaterials.js';
import { getNewsletterSecrets } from './remoteConfigSecrets.js';
import { paymentReminderUrl } from './applicationConciergePaymentReminders.js';
import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, APPLICATION_CONCIERGE_MAX_POSITIONS, acceptedPositionsCount, serviceIsActive, timestampMillis } from './applicationConciergeConstants.js';
import { conciergeRefreshDue, conciergeRenewalOffer } from './applicationConciergeLifecyclePolicy.js';
import * as conciergeMatcher from './applicationConciergeMatching.js';
const { runApplicationConciergeMatching } = conciergeMatcher;
import { buildConciergeNewJobsEmail, buildConciergeRenewalEmail } from './applicationConciergeLifecycleEmails.js';
import { sendOrderNotification } from './assistedApplicationNotifications.js';

const REFRESH_LEASE_MS = 10 * 60 * 1000;
function underCap(service) {
  return acceptedPositionsCount(service) < (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS);
}
async function claimRefresh(db, ref, nowMs, enqueueOnly) {
  const requestId = randomUUID();
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const service = snapshot.data();
    if (!snapshot.exists || service?.pendingProposalNotice || !conciergeRefreshDue(service, nowMs)) return false;
    const claimed = timestampMillis(service.proposalRefreshClaimedAt);
    if (claimed && nowMs - claimed < REFRESH_LEASE_MS) return false;
    tx.set(ref, { proposalRefreshClaimedAt: new Date(nowMs),
      ...(enqueueOnly ? { proposalRefreshRequestId: requestId, proposalRefreshRequestedBy: 'lifecycle' } : {}) }, { merge: true });
    return true;
  });
}

async function deliverNewProposals({ db, ref, nowMs, send }) {
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
    build: (current, options) => buildConciergeNewJobsEmail(current, ref.id, proposals, options),
  });
  if (result.ok || ['already_sent', 'already_ambiguous'].includes(result.reason)) {
    await ref.set({ pendingProposalNotice: FieldValue.delete() }, { merge: true });
  }
  return result.ok;
}

/** One document-trigger worker per service: no user's AI work can starve another service's sweep. */
export async function runConciergeProposalRefresh({ db, serviceId, requestId = null, nowMs = Date.now(), match = runApplicationConciergeMatching, send = sendOrderNotification, deadlineMs = null }) {
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const claimed = await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!serviceIsActive(current, nowMs) || !underCap(current)
      || (requestId && current.proposalRefreshRequestId !== requestId)) return false;
    const started = timestampMillis(current.proposalRefreshWorkerStartedAt);
    if (started && nowMs - started < REFRESH_LEASE_MS) return false;
    tx.set(ref, { proposalRefreshWorkerStartedAt: new Date(nowMs) }, { merge: true });
    return true;
  });
  if (!claimed) return { refreshed: 0, newJobEmails: 0 };
  let refreshed = 0;
  try {
    const before = await ref.collection('proposals').get();
    const known = new Set(before.docs.map(d => d.id));
    const result = await match({ db, serviceId, ...(deadlineMs ? { deadlineMs } : {}) });
    if (result.status === 'complete') {
      refreshed = 1;
      const after = await ref.collection('proposals').get();
      const ids = after.docs.filter(d => !known.has(d.id) && d.data().status === 'proposed').map(d => d.id).sort();
      if (ids.length) {
        const key = `new_proposals_${createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 24)}`;
        await db.runTransaction(async tx => {
          const current = (await tx.get(ref)).data();
          if (!current?.pendingProposalNotice && serviceIsActive(current, nowMs) && underCap(current)) {
            tx.set(ref, { pendingProposalNotice: { key, proposalIds: ids, createdAt: new Date(nowMs) } }, { merge: true });
          }
        });
      }
    }
    return { refreshed, newJobEmails: await deliverNewProposals({ db, ref, nowMs, send }) ? 1 : 0 };
  } finally {
    await ref.set({ proposalRefreshClaimedAt: FieldValue.delete(), proposalRefreshWorkerStartedAt: FieldValue.delete() }, { merge: true });
  }
}

export async function runConciergeLifecycleSweep({ db, nowMs = Date.now(), match = runApplicationConciergeMatching, send = sendOrderNotification, unsubscribeSecret = null, enqueueOnly = true }) {
  const secret = unsubscribeSecret ?? (await getNewsletterSecrets()).newsletterSecret;
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('paymentStatus', '==', 'paid').get();
  const summary = { queuedRefreshes: 0, refreshed: 0, newJobEmails: 0, renewalEmails: 0, failed: 0 };
  for (const document of snapshot.docs || []) {
    const ref = document.ref;
    try {
      await inheritConciergeRenewalMaterials({ db, serviceId: ref.id, nowMs });
      // Retry a failed notice before a later refresh can replace its pending batch.
      if (await deliverNewProposals({ db, ref, nowMs, send })) summary.newJobEmails += 1;
      // A rolling deployment must never email lexical-only matches as verified proposals.
      const verifiedMatcherAvailable = match !== runApplicationConciergeMatching || conciergeMatcher.APPLICATION_CONCIERGE_REQUIREMENTS_VERIFIED === true;
      if (verifiedMatcherAvailable && await claimRefresh(db, ref, nowMs, enqueueOnly)) {
        if (enqueueOnly) summary.queuedRefreshes += 1;
        else {
          const result = await runConciergeProposalRefresh({ db, serviceId: ref.id, nowMs, match, send });
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
