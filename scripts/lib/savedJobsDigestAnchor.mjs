/**
 * The `newsletter_subscribers/{email}` address record of an account mail that
 * has no newsletter relationship (owner decision 2026-10-03, "includili al
 * salvataggio"): the weekly saved-jobs digest, and the one-shot
 * application-intent reminder that goes to the same verified Auth addresses.
 *
 * The provider webhooks record a bounce or a complaint only on an existing row
 * (UNKNOWN_RECIPIENT in functions/src/lib/subscriberReactivation.js), so an
 * account mail sent to an address without one could never be stopped by a
 * complaint. The record carries the digest's marker (`saved_jobs_digest_anchor`)
 * and nothing that makes a row a subscription: `hasSubscriptionBasis`,
 * `hasNewsletterSubscriberRecord` and `isSavedJobsDigestAnchorOnly`
 * (functions/src/lib/subscriberConsent.js) refuse it as one, whatever a webhook,
 * the decay or the Mailtrap retry writes on it later. Admin SDK only: the
 * browser cannot write the marker (firestore.rules).
 */
import {
  SAVED_JOBS_DIGEST_ANCHOR_FIELD,
  hasSubscriptionBasis,
  isSavedJobsDigestAnchorOnly,
} from '../../services/subscriberConsent.mjs';

/**
 * The record created for an account with no central row: the
 * address, the uid (account deletion finds email-keyed rows by it, see
 * functions/src/authAccountCleanup.js) and the digest's own marker, nothing
 * else. No status, terms, consent, `source_channel` or creation stamp: those
 * are what make a row a subscription, and `isSavedJobsDigestAnchorOnly`
 * (functions/src/lib/subscriberConsent.js) reads their absence.
 */
export function buildSavedJobsDigestAnchor({ uid, email, activationSource = null, now = new Date() }) {
  return {
    email,
    auth_uid: uid,
    [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: {
      created_at: now,
      activation_source: activationSource || null,
    },
  };
}

/**
 * Create that record unless a row appeared meanwhile, and return the row the
 * eligibility check must read: a concurrent sign-in may have registered the
 * address, an unsubscribe may have landed. Never overwrites an existing row.
 */
export async function ensureSavedJobsDigestAnchor(db, { uid, email, activationSource = null }) {
  const ref = db.collection('newsletter_subscribers').doc(email);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const exists = typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists;
    if (exists) return snapshot.data?.() || {};
    const anchor = buildSavedJobsDigestAnchor({ uid, email, activationSource });
    transaction.create(ref, anchor);
    return anchor;
  });
}

/**
 * Whether the marker would make this row the digest's record: no marker yet,
 * no subscription basis (marking a row that has one would take the newsletter
 * away from it), and none of the capture or consent acts that
 * `isSavedJobsDigestAnchorOnly` reads as a relationship (a row carrying one
 * would ignore the marker anyway).
 */
export function isUnmarkedSavedJobsDigestRecord(data) {
  if (!data || typeof data !== 'object' || data[SAVED_JOBS_DIGEST_ANCHOR_FIELD]) return false;
  if (hasSubscriptionBasis(data)) return false;
  return isSavedJobsDigestAnchorOnly({ ...data, [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: {} });
}

/**
 * A row that exists but holds no relationship is the digest's address record
 * in fact: the legacy profile-only documents a sign-in wrote before #8341's
 * reconciliation stopped it (name, photo, `auth_uid`, `lastLoginAt`; 235 rows
 * measured 2026-09-24, see `hasSubscriptionBasis`). The digest already mails
 * them, so a bounce, a recovery, the decay or the Mailtrap retry can write a
 * `status` on them, and any status is a subscription basis: the newsletter
 * would start. Stamping the digest's marker, and nothing else, puts them under
 * the same protection as the record created above. A row that holds a
 * relationship, or already carries the marker, is returned untouched.
 */
export async function markSavedJobsDigestRecord(db, { email, activationSource = null, now = new Date() }) {
  const ref = db.collection('newsletter_subscribers').doc(email);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const exists = typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists;
    if (!exists) return null;
    const data = snapshot.data?.() || {};
    if (!isUnmarkedSavedJobsDigestRecord(data)) return data;
    const marker = { created_at: now, activation_source: activationSource || null };
    transaction.set(ref, { [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: marker }, { merge: true });
    return { ...data, [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: marker };
  });
}

/**
 * The record an account mail must have before it is sent: created when the
 * address has no row, the marker added when it has a legacy row with no
 * relationship, left alone otherwise. Returns the row the caller's stop check
 * must read.
 */
export async function ensureAccountMailRecord(db, { uid, email, activationSource = null }) {
  const row = await ensureSavedJobsDigestAnchor(db, { uid, email, activationSource });
  if (!isUnmarkedSavedJobsDigestRecord(row)) return row;
  return (await markSavedJobsDigestRecord(db, { email, activationSource })) || row;
}
