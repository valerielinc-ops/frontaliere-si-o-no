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
 *
 * Since #5705 the shared `shouldSkipSubscriber` also requires an affirmative,
 * job-alert-scoped consent on the subscriber document, so this handler returns
 * `{created: false, reason: 'no-job-alert-consent'}` — writing nothing — for
 * every subscriber whose consent covers the newsletter only. That is the case
 * for the whole list today; see the consent-gate section in
 * `jobAlertBackfillCore.js` for why a signal tier is not a request.
 *
 * Also invoked, with a `personalization` dep, from the companion
 * `backfillJobAlertOnPersonalizationSync` trigger (functions/index.js) on
 * writes to the SEPARATE `private/personalization` subdoc — the tier-3
 * fallback source this doc-level trigger never sees (different document
 * path; see `resolveSignalTier` in `jobAlertBackfillCore.js`).
 */

import admin from 'firebase-admin';
import {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  shouldSkipSubscriber,
  buildAlertPayload,
  resolveSignalTier,
} from './jobAlertBackfillCore.js';

export function getAdminDb() {
  return admin.firestore();
}

/**
 * @param {string} emailId  the newsletter_subscribers/{email} doc id
 * @param {Record<string, unknown>} data  the doc's field data
 * @param {{db?: FirebaseFirestore.Firestore, personalization?: Record<string, unknown>|null}} [deps]
 *   `personalization` is the `private/personalization` subdoc — pass it from
 *   `backfillJobAlertOnPersonalizationSync` (functions/index.js) to also
 *   consider the tier-3 fallback; the flat-field trigger omits it.
 * @returns {Promise<{created: boolean, reason?: string, tier?: string}>}
 */
export async function handleNewsletterSubscriberCreated(
  emailId,
  data,
  { db = getAdminDb(), personalization = null } = {},
) {
  if (!emailId || emailId === '_meta_') {
    return { created: false, reason: 'meta_sentinel' };
  }

  const email = normalizeEmail(data?.email || emailId);
  const skipReason = shouldSkipSubscriber(email, data, personalization);
  if (skipReason) {
    return { created: false, reason: skipReason };
  }

  const subscriberRef = db.collection('job_alert_subscribers').doc(email);
  const alertsRef = subscriberRef.collection('alerts');
  // Read every alert doc (not just active:true) — mirrors the batch script,
  // so a pre-existing user-disabled backfill doc is never mistaken for absent.
  const existingAlerts = await alertsRef.get();
  const existingBackfillDoc = existingAlerts.docs.find((d) => d.id === ALERT_ID);
  // Company follows are NOT counted here (#5012): they hold their own budget
  // (MAX_COMPANY_ALERTS_PER_USER), and letting them block the backfill would
  // mean a user who follows ten employers silently never gets the keyword alert
  // this trigger exists to create.
  const activeOtherCount = existingAlerts.docs.filter(
    (d) => d.id !== ALERT_ID && d.data().active === true && !d.data().specificCompanyKey,
  ).length;
  if (!existingBackfillDoc && activeOtherCount >= MAX_ALERTS_PER_USER) {
    return { created: false, reason: 'capped' };
  }

  const alertPayload = buildAlertPayload(email, data, existingBackfillDoc?.data(), personalization);
  // Tier-3 carries a real derived signal (category/location) worth persisting
  // onto the subscriber doc itself — same no-clobber patch the daily
  // send-job-alerts.mjs enrichment writes for subscribers who already have an
  // alert — so buildAlertProfile benefits from it starting with this alert's
  // very first match run, not just after the next manual enrichment pass.
  const { patch } = resolveSignalTier(data, personalization);

  const parentPayload = {
    email,
    userId: alertPayload.userId,
    locale: alertPayload.locale,
    ...(patch || {}),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  const existingParent = await subscriberRef.get();
  if (existingParent.exists) delete parentPayload.created_at;
  await subscriberRef.set(parentPayload, { merge: true });

  if (patch) {
    // buildAlertProfile (services/jobAlertMatching.mjs) reads
    // job_category/location_interest off newsletter_subscribers/{email},
    // NOT the job_alert_subscribers container doc above — merge the patch
    // there too so the derived signal is actually visible to matching, and
    // so getSignalTier(parentData) in backfillJobAlertOnPersonalizationSync
    // (functions/index.js) sees the resolved tier and stops re-reading
    // private/personalization on every subsequent write.
    await db.collection('newsletter_subscribers').doc(email).set(patch, { merge: true });
  }

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
