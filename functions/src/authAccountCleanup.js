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
import {
 APPLICATION_INTENTS_COLLECTION,
 APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION,
 buildApplicationIntentAccountTombstone,
} from './applicationIntentPrivacy.js';

const DELETE_PAGE_SIZE = 450;

export const ACCOUNT_DELETED_STATUS = 'account_deleted';

function applicationIntentBelongsToUid(data, uid) {
 if (!data || typeof data !== 'object') return false;
 const explicitUid = [data.userId, data.uid, data.accountUid]
  .some((candidate) => typeof candidate === 'string' && candidate.trim() === uid);
 const canonicalUid = data.identifierType === 'firebase_uid'
  && typeof data.identifier === 'string'
  && data.identifier.trim() === uid;
 return explicitUid || canonicalUid;
}

async function collectApplicationIntentRefs(db, uid) {
 const refs = new Map();
 const addDocs = (snapshot, filterByUid = true) => {
  for (const docSnap of snapshot?.docs || []) {
   if (!filterByUid || applicationIntentBelongsToUid(docSnap.data?.(), uid)) {
    const key = docSnap.ref?.path || docSnap.id;
    if (key) refs.set(key, docSnap.ref);
   }
  }
 };

 const root = db.collection(APPLICATION_INTENTS_COLLECTION);
 const direct = await root.doc(uid).get();
 if (direct.exists) addDocs({ docs: [direct] }, false);
 if (typeof root.where === 'function') {
  // Single-field queries avoid a composite index and cover explicit identity
  // fields plus the canonical writer's verified Firebase uid identifier.
  const snapshots = await Promise.all(
   ['userId', 'uid', 'accountUid', 'identifier'].map((field) => root.where(field, '==', uid).get()),
  );
  snapshots.forEach((snapshot) => addDocs(snapshot));
 } else if (typeof root.limit === 'function') {
  // The small fake/in-memory adapters used by tests do not implement where;
  // filter their bounded collection scan locally rather than weakening the
  // production query contract.
  addDocs(await root.limit(DELETE_PAGE_SIZE).get());
 }

 // Also cover a user-scoped collection. It is tombstoned before users/{uid}
 // is deleted, so a late callback cannot find surviving personal fields there.
 const nested = db.collection('users').doc(uid).collection(APPLICATION_INTENTS_COLLECTION);
 if (typeof nested.limit === 'function') addDocs(await nested.limit(DELETE_PAGE_SIZE).get(), false);

 return [...refs.values()];
}

/**
 * Replace account-linked application-intent records with non-personal
 * tombstones and persist the account boundary used by late callbacks.
 *
 * The replacement is intentionally not a merge: email, user-agent, IP and
 * any other personal fields must not survive account deletion.
 */
export async function tombstoneApplicationIntentDataForDeletedUser(uid, injectedDb) {
 const db = injectedDb || admin.firestore();
 const tombstone = buildApplicationIntentAccountTombstone(uid);
 if (!tombstone) {
  return { tombstonedApplicationIntents: 0, tombstonedApplicationIntentAccount: false };
 }

 const accountTombstoneRef = db
  .collection(APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION)
  .doc(tombstone.userId);
 // Write the boundary first. A later read or batch failure must fail closed.
 await accountTombstoneRef.set(tombstone, { merge: true });

 const refs = await collectApplicationIntentRefs(db, tombstone.userId);
 let tombstonedApplicationIntents = 0;
 for (let offset = 0; offset < refs.length; offset += DELETE_PAGE_SIZE) {
  const batch = db.batch();
  const page = refs.slice(offset, offset + DELETE_PAGE_SIZE);
  for (const ref of page) batch.set(ref, tombstone);
  await batch.commit();
  tombstonedApplicationIntents += page.length;
 }

 return { tombstonedApplicationIntents, tombstonedApplicationIntentAccount: true };
}

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
 * Late provider callbacks must not recreate tracking data after account erasure.
 * Check both channel tombstones before ranking, subscriber or event writes.
 * Read errors propagate instead of bypassing the erasure check.
 */
export async function isDeletedEmailAccount(db, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const snapshots = await Promise.all([
    db.collection('newsletter_subscribers').doc(email).get(),
    db.collection('job_alert_subscribers').doc(email).get(),
  ]);
  return snapshots.some((snapshot) => (
    snapshot.exists && isAccountDeletedTombstone(snapshot.data())
  ));
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
  // Newsletter: `unsubscribed` is a channel-local exclusion. A hard address
  // suppression or an explicit stop-all is handled separately by the shared
  // cross-channel predicate. Confirmation mail is transactional and still
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
 * @returns {Promise<{deletedSavedJobs: number, tombstonedNewsletter: boolean, tombstonedJobAlert: boolean, deletedPetitionSignature: boolean, tombstonedApplicationIntents: number, tombstonedApplicationIntentAccount: boolean}>}
 */
export async function cleanupUserDataForDeletedAccount(user, injectedDb) {
 const db = injectedDb || admin.firestore();
 const { uid, email } = user || {};
 const applicationIntent = await tombstoneApplicationIntentDataForDeletedUser(uid, db);
 const subscribers = await tombstoneEmailKeyedSubscribers(email, db);
 // The tombstone is the safety boundary: finish it before best-effort data
 // deletion so a savedJobs failure can never leave the old email lifecycle
 // without an address-level cleanup marker.
 const saved = await cleanupSavedJobsForDeletedUser(uid, db);
 const petition = await cleanupPetitionSignatureForDeletedUser(uid, db);
 return { ...saved, ...subscribers, ...petition, ...applicationIntent };
}
