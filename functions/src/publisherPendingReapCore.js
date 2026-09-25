/**
 * Stale-checkout reaper — frees ads stuck in 'pending_payment'.
 *
 * A sponsored ad flips to 'pending_payment' when the publisher opens Stripe
 * Checkout (see stripePublisherCore createCheckout). If they abandon the page,
 * Stripe fires `checkout.session.expired` (default 24h) which the webhook turns
 * into a revert. This scheduled CF (`reapStalePendingPayments`, wired in
 * functions/index.js) is the BACKSTOP for the case where that webhook is missed,
 * undelivered, or the session never had an event: any ad sitting in
 * 'pending_payment' past the reap window is reverted to 'draft' so the publisher
 * can edit / re-submit it instead of it being stuck forever.
 *
 * The actual write is delegated to revertPendingJobsToDraft (stripePublisherCore)
 * which is GUARDED — it only touches docs still in 'pending_payment', so a racing
 * payment or archive is never clobbered. Idempotent.
 */

import admin from 'firebase-admin';

/** Reap pending_payment ads older than this. Stripe sessions expire at ~24h;
 *  48h leaves comfortable margin so a slow-but-real payment is never reaped. */
export const REAP_AFTER_MS = 48 * 60 * 60 * 1000;

function db() {
  return admin.firestore();
}

/**
 * Revert abandoned-checkout ads back to 'draft' — but ONLY the ones still sitting
 * in 'pending_payment'. Guarded per-doc so a racing payment that already flipped a
 * job to 'paid' (or a publisher who archived it) is never clobbered. Idempotent.
 * Shared by the `checkout.session.expired` webhook (stripePublisherCore) and the
 * daily reaper below.
 * @param {string[]} jobIds
 * @returns {Promise<number>} number of ads actually reverted
 */
export async function revertPendingJobsToDraft(jobIds) {
  if (!Array.isArray(jobIds) || !jobIds.length) return 0;
  let reverted = 0;
  for (const jobId of jobIds) {
    const ref = db().collection('publisher_jobs').doc(String(jobId));
    try {
      const did = await db().runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists || s.data().status !== 'pending_payment') return false;
        tx.set(
          ref,
          {
            status: 'draft',
            pendingPaymentAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return true;
      });
      if (did) reverted += 1;
    } catch (error) {
      console.error('[revertPendingJobsToDraft] failed', jobId, error instanceof Error ? error.message : String(error));
    }
  }
  return reverted;
}

/** epoch-millis | Firestore Timestamp | {_seconds} → millis | null. */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return null;
}

/**
 * Pure decision: is this ad an abandoned-checkout that should be reverted?
 * Age is measured from pendingPaymentAt (stamped at checkout), falling back to
 * updatedAt / createdAt. An ad with no usable timestamp is left untouched (we
 * never reap on unknown age).
 * @param {object} job   publisher_jobs document data
 * @param {number} nowMs reference time
 * @param {number} [thresholdMs=REAP_AFTER_MS]
 * @returns {boolean}
 */
export function isStalePendingPayment(job, nowMs, thresholdMs = REAP_AFTER_MS) {
  if (!job || job.status !== 'pending_payment') return false;
  const anchor = toMillis(job.pendingPaymentAt) ?? toMillis(job.updatedAt) ?? toMillis(job.createdAt);
  if (anchor == null) return false;
  return nowMs - anchor >= thresholdMs;
}

/**
 * Find every stale pending_payment ad and revert it to draft.
 * @param {number} [nowMs=Date.now()] injectable for tests
 * @returns {Promise<number>} number of ads reverted
 */
export async function reapStalePendingPayments(nowMs = Date.now()) {
  // Single-field query → auto-indexed (no composite index needed). Pending ads
  // are few, so the in-memory age filter is cheap.
  const snap = await db().collection('publisher_jobs').where('status', '==', 'pending_payment').get();
  if (snap.empty) return 0;
  const staleIds = snap.docs.filter((d) => isStalePendingPayment(d.data(), nowMs)).map((d) => d.id);
  if (!staleIds.length) return 0;
  return revertPendingJobsToDraft(staleIds);
}
