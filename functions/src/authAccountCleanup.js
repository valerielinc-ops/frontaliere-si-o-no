/**
 * authAccountCleanup.js — cascade-delete Firestore data on Firebase Auth
 * account deletion.
 *
 * `deleteCurrentUser()` (services/authService.ts) only removes the Auth
 * user — it never touches Firestore. Without this trigger, `users/{uid}` and
 * its `savedJobs` subcollection become permanently orphaned (no client can
 * read them again: every rule on that path requires `request.auth.uid ==
 * uid`, and that uid can never authenticate again).
 *
 * `users/{uid}` holds only saved-jobs-feature data (email, locale,
 * savedJobsDigest.optedOut — see savedJobsService.ensureUserProfileDoc) with
 * no other reader in the repo, so deleting the whole doc alongside the
 * subcollection is safe — nothing else depends on it surviving.
 *
 * Email-keyed subscriber docs are a different hole: firestore.rules has no
 * `allow delete` on `newsletter_subscribers/{email}`, so the profile page's
 * client `deleteDoc` is denied and was being swallowed. Auth disappears, the
 * `pending` row stays, and `sendNewsletterConfirmationEmail` still mails.
 * Client rules cannot fix that; this Admin-SDK path tombstones those rows
 * (kept, not deleted) so a later derived merge-write cannot mint a fresh Auth
 * user; only a registration that explicitly clears the marker reopens Auth
 * synchronization.
 *
 * Deletes in pages of 450 (under Firestore's 500-writes-per-batch limit)
 * because the client-side SAVED_JOBS_CAP (100) is a soft, client-enforced
 * ceiling, not a server-guaranteed one.
 */

import admin from 'firebase-admin';

const DELETE_PAGE_SIZE = 450;

export const ACCOUNT_DELETED_STATUS = 'account_deleted';

/**
 * Petition signatures are keyed by Auth uid, so account deletion must remove
 * the private signature as well. The aggregate counter is intentionally kept:
 * it is a public historical petition metric, not account data.
 */
export async function cleanupPetitionSignatureForDeletedUser(uid, injectedDb) {
  const db = injectedDb || admin.firestore();
  await db.collection('petition_signatures').doc(uid).delete();
  return { deletedPetitionSignature: true };
}

/**
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {boolean}
 */
export function isAccountDeletedTombstone(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.account_deleted_at) return true;
  return String(data.status || '').trim().toLowerCase() === ACCOUNT_DELETED_STATUS;
}

/**
 * @param {string} uid
 * @param {import('firebase-admin/firestore').Firestore} [injectedDb]
 * @returns {Promise<{deletedSavedJobs: number}>}
 */
export async function cleanupSavedJobsForDeletedUser(uid, injectedDb) {
  const db = injectedDb || admin.firestore();
  const savedJobsRef = db.collection('users').doc(uid).collection('savedJobs');

  let deletedSavedJobs = 0;
  for (;;) {
    const page = await savedJobsRef.limit(DELETE_PAGE_SIZE).get();
    if (page.empty) break;
    const batch = db.batch();
    for (const docSnap of page.docs) batch.delete(docSnap.ref);
    await batch.commit();
    deletedSavedJobs += page.size;
    if (page.size < DELETE_PAGE_SIZE) break;
  }

  await db.collection('users').doc(uid).delete();

  return { deletedSavedJobs };
}

/**
 * @param {string|null|undefined} rawEmail
 * @param {import('firebase-admin/firestore').Firestore} db
 * @returns {Promise<{tombstonedNewsletter: boolean, tombstonedJobAlert: boolean}>}
 */
export async function tombstoneEmailKeyedSubscribers(rawEmail, db) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return { tombstonedNewsletter: false, tombstonedJobAlert: false };
  }

  const stamp = new Date().toISOString();
  // Newsletter: `unsubscribed` is already in NEWSLETTER_EXCLUDED_STATUSES and
  // CROSS_CHANNEL_STOP_STATUSES. Confirmation mail is transactional and still
  // sends to `unsubscribed` — `account_deleted_at` is the extra signal that
  // send + Auth-sync consult. Job alerts: `inactive` is that channel's
  // exclusion status (it has no `unsubscribed`).
  const newsletterTombstone = {
    status: 'unsubscribed',
    isActive: false,
    account_deleted_at: stamp,
    unsubscribed_at: stamp,
  };
  const jobAlertTombstone = {
    status: 'inactive',
    isActive: false,
    account_deleted_at: stamp,
  };

  await Promise.all([
    db.collection('newsletter_subscribers').doc(email).set(newsletterTombstone, { merge: true }),
    db.collection('job_alert_subscribers').doc(email).set(jobAlertTombstone, { merge: true }),
  ]);

  return { tombstonedNewsletter: true, tombstonedJobAlert: true };
}

/**
 * @param {{uid: string, email?: string|null}} user
 * @param {import('firebase-admin/firestore').Firestore} [injectedDb]
 * @returns {Promise<{deletedSavedJobs: number, tombstonedNewsletter: boolean, tombstonedJobAlert: boolean, deletedPetitionSignature: boolean}>}
 */
export async function cleanupUserDataForDeletedAccount(user, injectedDb) {
 const db = injectedDb || admin.firestore();
 const { uid, email } = user || {};
 const subscribers = await tombstoneEmailKeyedSubscribers(email, db);
 // The tombstone is the safety boundary: finish it before best-effort data
 // deletion so a savedJobs failure can never leave the old email lifecycle
 // without an address-level cleanup marker.
 const saved = await cleanupSavedJobsForDeletedUser(uid, db);
 const petition = await cleanupPetitionSignatureForDeletedUser(uid, db);
 return { ...saved, ...subscribers, ...petition };
}
