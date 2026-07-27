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
 * Deletes in pages of 450 (under Firestore's 500-writes-per-batch limit)
 * because the client-side SAVED_JOBS_CAP (100) is a soft, client-enforced
 * ceiling, not a server-guaranteed one.
 */

import admin from 'firebase-admin';

const DELETE_PAGE_SIZE = 450;

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
