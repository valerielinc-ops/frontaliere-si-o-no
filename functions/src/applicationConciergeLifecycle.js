/** Scheduled lifecycle: refresh active services, deliver new proposals, then offer a renewal on expiry. */
import { inheritConciergeRenewalMaterials } from './applicationConciergeRenewalMaterials.js';
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, APPLICATION_CONCIERGE_MAX_POSITIONS, acceptedPositionsCount, serviceIsActive, timestampMillis } from './applicationConciergeConstants.js';
import { conciergeRefreshDue, conciergeRenewalOffer } from './applicationConciergeLifecyclePolicy.js';
import { runApplicationConciergeMatching } from './applicationConciergeMatching.js';
import { buildConciergeNewJobsEmail, buildConciergeRenewalEmail } from './applicationConciergeLifecycleEmails.js';
import { sendOrderNotification } from './assistedApplicationNotifications.js';

const REFRESH_LEASE_MS = 10 * 60 * 1000;
function underCap(service) {
  return acceptedPositionsCount(service) < (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS);
}
async function claimRefresh(db, ref, nowMs) {
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const service = snapshot.data();
    if (!snapshot.exists || service?.pendingProposalNotice || !conciergeRefreshDue(service, nowMs)) return false;
    const claimed = timestampMillis(service.proposalRefreshClaimedAt);
    if (claimed && nowMs - claimed < REFRESH_LEASE_MS) return false;
    tx.set(ref, { proposalRefreshClaimedAt: new Date(nowMs) }, { merge: true });
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
    build: (current, options) => buildConciergeNewJobsEmail(current, ref.id, proposals, options),
  });
  if (result.ok || ['already_sent', 'already_ambiguous'].includes(result.reason)) {
    await ref.set({ pendingProposalNotice: FieldValue.delete() }, { merge: true });
  }
  return result.ok;
}

export async function runConciergeLifecycleSweep({ db, nowMs = Date.now(), match = runApplicationConciergeMatching, send = sendOrderNotification }) {
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).where('paymentStatus', '==', 'paid').get();
  const summary = { refreshed: 0, newJobEmails: 0, renewalEmails: 0, failed: 0 };
  for (const document of snapshot.docs || []) {
    const ref = document.ref;
    try {
      await inheritConciergeRenewalMaterials({ db, serviceId: ref.id });
      // Retry a failed notice before a later refresh can replace its pending batch.
      if (await deliverNewProposals({ db, ref, nowMs, send })) summary.newJobEmails += 1;
      if (await claimRefresh(db, ref, nowMs)) {
        try {
          const before = await ref.collection('proposals').get();
          const known = new Set(before.docs.map(d => d.id));
          const result = await match({ db, serviceId: ref.id });
          if (result.status === 'complete') {
            summary.refreshed += 1;
            const after = await ref.collection('proposals').get();
            const ids = after.docs.filter(d => !known.has(d.id) && d.data().status === 'proposed').map(d => d.id).sort();
            if (ids.length) {
              const key = `new_proposals_${createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 24)}`;
              await db.runTransaction(async tx => {
                const latest = (await tx.get(ref)).data();
                if (!latest?.pendingProposalNotice && serviceIsActive(latest, nowMs) && underCap(latest)) {
                  tx.set(ref, { pendingProposalNotice: { key, proposalIds: ids, createdAt: new Date(nowMs) } }, { merge: true });
                }
              });
            }
          }
        } finally {
          await ref.set({ proposalRefreshClaimedAt: FieldValue.delete() }, { merge: true });
        }
        if (await deliverNewProposals({ db, ref, nowMs, send })) summary.newJobEmails += 1;
      }
      const current = (await ref.get()).data();
      const offer = conciergeRenewalOffer(current, nowMs);
      if (offer?.discounted && !current.lifecycleEmailsUnsubscribedAt) {
        const result = await send({ db, recordRef: ref, orderId: ref.id, key: `renewal_day_${offer.reminderStage}`, audience: 'customer', nowMs,
          build: (service, options) => buildConciergeRenewalEmail(service, ref.id, { ...options, nowMs }),
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
