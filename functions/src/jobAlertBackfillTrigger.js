/**
 * Real-time counterpart of `scripts/backfill-jobalerts-from-newsletter.mjs`.
 * Invoked from an `onDocumentWritten` trigger on every
 * `newsletter_subscribers/{email}` write going forward (see
 * functions/index.js → `backfillJobAlertOnNewsletterSignup`), gated by
 * `signalTierChanged` so it only does real work when eligibility actually
 * flips — see the rationale in `jobAlertBackfillCore.js` for why a plain
 * `onDocumentCreated` misses subscribers whose signal fields arrive via a
 * later merge write.
 *
 * Shares the exact decision logic with the batch script via
 * `jobAlertBackfillCore.js` — no drift between "day-0 backfill of existing
 * docs" and "day-N auto-creation for new ones".
 */

import admin from 'firebase-admin';
import {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  shouldSkipSubscriber,
  buildAlertPayload,
} from './jobAlertBackfillCore.js';

export function getAdminDb() {
  return admin.firestore();
}

/**
 * @param {string} emailId  the newsletter_subscribers/{email} doc id
 * @param {Record<string, unknown>} data  the doc's field data
 * @param {{db?: FirebaseFirestore.Firestore}} [deps]
 * @returns {Promise<{created: boolean, reason?: string, tier?: string}>}
 */
export async function handleNewsletterSubscriberCreated(emailId, data, { db = getAdminDb() } = {}) {
  if (!emailId || emailId === '_meta_') {
    return { created: false, reason: 'meta_sentinel' };
  }

  const email = normalizeEmail(data?.email || emailId);
  const skipReason = shouldSkipSubscriber(email, data);
  if (skipReason) {
    return { created: false, reason: skipReason };
  }

  const subscriberRef = db.collection('job_alert_subscribers').doc(email);
  const alertsRef = subscriberRef.collection('alerts');
  // Read every alert doc (not just active:true) — mirrors the batch script,
  // so a pre-existing user-disabled backfill doc is never mistaken for absent.
  const existingAlerts = await alertsRef.get();
  const existingBackfillDoc = existingAlerts.docs.find((d) => d.id === ALERT_ID);
  const activeOtherCount = existingAlerts.docs.filter(
    (d) => d.id !== ALERT_ID && d.data().active === true,
  ).length;
  if (!existingBackfillDoc && activeOtherCount >= MAX_ALERTS_PER_USER) {
    return { created: false, reason: 'capped' };
  }

  const alertPayload = buildAlertPayload(email, data, existingBackfillDoc?.data());

  const parentPayload = {
    email,
    userId: alertPayload.userId,
    locale: alertPayload.locale,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  const existingParent = await subscriberRef.get();
  if (existingParent.exists) delete parentPayload.created_at;
  await subscriberRef.set(parentPayload, { merge: true });

  await alertsRef.doc(ALERT_ID).set(
    {
      ...alertPayload,
      backfilled_at: admin.firestore.FieldValue.serverTimestamp(),
      ...(existingBackfillDoc ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );

  return { created: true, tier: alertPayload.backfilled_from };
}
