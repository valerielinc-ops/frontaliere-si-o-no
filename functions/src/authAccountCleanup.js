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

import { getFirestore } from 'firebase-admin/firestore';
import {
 APPLICATION_INTENTS_COLLECTION,
 APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION,
 APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION,
 buildApplicationIntentAccountTombstone,
} from './applicationIntentPrivacy.js';
import { eraseJobEmailAffinityProfile } from './lib/jobEmailAffinityStore.js';

const DELETE_PAGE_SIZE = 450;
const SUBSCRIBER_UID_FIELDS = Object.freeze(['user_id', 'userId', 'uid', 'auth_uid']);

function normalizedEmail(value) {
 const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
 return email && email.includes('@') ? email : '';
}

function emailFromPersonalizationPath(path) {
 const segments = String(path || '').split('/');
 if (segments.length !== 4 || segments[0] !== 'newsletter_subscribers' || segments[2] !== 'private') return '';
 return normalizedEmail(segments[1]);
}

/**
 * Find every email-keyed projection that still proves ownership of the Auth
 * uid. Firebase Auth exposes only the current email on onDelete; an address
 * change can therefore leave the old subscriber/private documents behind if
 * cleanup trusts the event's email alone.
 */
async function collectHistoricalSubscriberEmails(db, uid, currentEmail) {
 const emails = new Set();
 const current = normalizedEmail(currentEmail);
 if (current) emails.add(current);

 for (const collectionName of ['newsletter_subscribers', 'job_alert_subscribers']) {
  const collection = db.collection(collectionName);
  if (typeof collection?.where !== 'function') continue;
  for (const field of SUBSCRIBER_UID_FIELDS) {
   const snapshot = await collection.where(field, '==', uid).get();
   for (const docSnap of snapshot?.docs || []) {
    const email = normalizedEmail(docSnap.id);
    if (email) emails.add(email);
   }
  }
 }

 // The private projection is the durable binding used by newsletter/job-alert
 // personalization. A collection-group lookup covers old email documents
 // even after the public subscriber row stopped carrying the uid.
 if (typeof db.collectionGroup === 'function') {
  const privateCollection = db.collectionGroup('private');
  const query = typeof privateCollection?.where === 'function'
   ? privateCollection.where('applicationIntentAuthUid', '==', uid)
   : privateCollection;
  const snapshot = await query.get();
  for (const docSnap of snapshot?.docs || []) {
   if (docSnap.id !== 'personalization') continue;
   const email = emailFromPersonalizationPath(docSnap.ref?.path);
   if (email) emails.add(email);
  }
 }

 return [...emails];
}

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
 const db = injectedDb || getFirestore();
 const tombstone = buildApplicationIntentAccountTombstone(uid);
 if (!tombstone) {
  return {
   tombstonedApplicationIntents: 0,
   deletedApplicationIntentReminderDeliveries: 0,
   tombstonedApplicationIntentAccount: false,
  };
 }

 const accountTombstoneRef = db
  .collection(APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION)
  .doc(tombstone.userId);
 // Write the boundary first. A later read or batch failure must fail closed.
 await accountTombstoneRef.set(tombstone, { merge: true });

 const refs = await collectApplicationIntentRefs(db, tombstone.userId);
 let deletedApplicationIntentReminderDeliveries = 0;
 for (let offset = 0; offset < refs.length; offset += DELETE_PAGE_SIZE) {
  const batch = db.batch();
  const page = refs.slice(offset, offset + DELETE_PAGE_SIZE);
  for (const ref of page) {
   batch.delete(db.collection(APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION).doc(ref.id));
  }
  if (page.length > 0) {
   await batch.commit();
   deletedApplicationIntentReminderDeliveries += page.length;
  }
 }
 let tombstonedApplicationIntents = 0;
 for (let offset = 0; offset < refs.length; offset += DELETE_PAGE_SIZE) {
  const batch = db.batch();
  const page = refs.slice(offset, offset + DELETE_PAGE_SIZE);
  for (const ref of page) batch.set(ref, tombstone);
  await batch.commit();
  tombstonedApplicationIntents += page.length;
 }

 return {
  tombstonedApplicationIntents,
  deletedApplicationIntentReminderDeliveries,
  tombstonedApplicationIntentAccount: true,
 };
}

/**
 * Petition signatures are keyed by Auth uid, so account deletion must remove
 * the private signature as well. The aggregate counter is intentionally kept:
 * it is a public historical petition metric, not account data.
 */
export async function cleanupPetitionSignatureForDeletedUser(uid, injectedDb) {
  const db = injectedDb || getFirestore();
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
  const db = injectedDb || getFirestore();
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
 * @param {{newsletterSecret?: string}} [options] NEWSLETTER_SECRET, for the
 *        pseudonymous id of the click-affinity profile (read from Remote Config
 *        when absent).
 * @returns {Promise<{tombstonedNewsletter: boolean, tombstonedJobAlert: boolean, affinityProfileErased: boolean}>}
 */
export async function tombstoneEmailKeyedSubscribers(rawEmail, db, { newsletterSecret } = {}) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return { tombstonedNewsletter: false, tombstonedJobAlert: false, affinityProfileErased: false };
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

  const [, , , affinity] = await Promise.all([
    db.collection('newsletter_subscribers').doc(email).set(newsletterTombstone, { merge: true }),
    db.collection('job_alert_subscribers').doc(email).set(jobAlertTombstone, { merge: true }),
    // Browsing/application-intent personalization is account-linked private
    // data. Unlike the public subscriber row it has no useful post-deletion
    // tombstone semantics, so remove it rather than leaving a UID-bound copy.
    db.collection('newsletter_subscribers').doc(email)
      .collection('private').doc('personalization').delete(),
    // The click-affinity profile used to order job ads (privacy policy:
    // deleted at once when the account is deleted). Keyed by a pseudonym of
    // the address, so it has no uid to find it by.
    eraseJobEmailAffinityProfile(db, email, { secret: newsletterSecret }),
  ]);

  return {
    tombstonedNewsletter: true,
    tombstonedJobAlert: true,
    affinityProfileErased: affinity?.deleted === true,
  };
}

/**
 * @param {{uid: string, email?: string|null}} user
 * @param {import('firebase-admin/firestore').Firestore} [injectedDb]
 * @returns {Promise<{deletedSavedJobs: number, tombstonedNewsletter: boolean, tombstonedJobAlert: boolean, deletedPetitionSignature: boolean, tombstonedApplicationIntents: number, deletedApplicationIntentReminderDeliveries: number, tombstonedApplicationIntentAccount: boolean}>}
 */
export async function cleanupUserDataForDeletedAccount(user, injectedDb, { newsletterSecret } = {}) {
  const db = injectedDb || getFirestore();
 const { uid, email } = user || {};
 const applicationIntent = await tombstoneApplicationIntentDataForDeletedUser(uid, db);
 const subscriberEmails = await collectHistoricalSubscriberEmails(db, uid, email);
 const subscriberResults = await Promise.all(
  subscriberEmails.map((subscriberEmail) => tombstoneEmailKeyedSubscribers(subscriberEmail, db, { newsletterSecret })),
 );
 const subscribers = {
  tombstonedNewsletter: subscriberResults.some((result) => result.tombstonedNewsletter),
  tombstonedJobAlert: subscriberResults.some((result) => result.tombstonedJobAlert),
  affinityProfileErased: subscriberResults.some((result) => result.affinityProfileErased),
 };
 // The tombstone is the safety boundary: finish it before best-effort data
 // deletion so a savedJobs failure can never leave the old email lifecycle
 // without an address-level cleanup marker.
 const saved = await cleanupSavedJobsForDeletedUser(uid, db);
 const petition = await cleanupPetitionSignatureForDeletedUser(uid, db);
 return { ...saved, ...subscribers, ...petition, ...applicationIntent };
}
