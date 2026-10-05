#!/usr/bin/env node
/**
 * backfill-saved-jobs-digest-optin.mjs — one-time activation of the weekly
 * saved-jobs digest for accounts that saved a listing before activation-on-save.
 *
 * Owner decision of 2026-10-05, superseding the "no backfill" of 2026-10-02.
 * Since #8754 (2026-09-16) the digest requires `users/{uid}.savedJobsDigest
 * .optedIn === true`; activation-on-save only arrived on 2026-10-02, so the
 * accounts that saved before it were never activated and the digest sent 0 on
 * 2026-09-21 and 2026-09-28 (147 skipped). Saving a listing on 2026-10-01 and on
 * 2026-10-03 is the same signal; only the release date told them apart.
 *
 * Writes exactly what services/savedJobsService.ts writes on a save —
 * `{ optedIn: true, optedInAt, activationSource }` under `savedJobsDigest`,
 * merged, inside a transaction that re-checks the state — with its own
 * provenance (`saved_job_backfill`) so the cohort stays distinguishable.
 * Only a never-decided digest is touched: an explicit stop (`optedOut`) is
 * final, and an active digest needs no write. The account must also pass the
 * digest's own delivery gate: a `newsletter_subscribers/{email}` record with
 * no cross-channel stop (scripts/send-saved-jobs-digest.mjs).
 *
 * Usage:
 *   node scripts/backfill-saved-jobs-digest-optin.mjs           # dry-run (default)
 *   node scripts/backfill-saved-jobs-digest-optin.mjs --apply   # write
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS (Firebase service account JSON).
 */
import { pathToFileURL } from 'node:url';
import { isCrossChannelStop } from '../services/emailSuppression.mjs';
import { savedJobsDigestChoice } from '../services/savedJobsDigestActivation.mjs';

export const SAVED_JOBS_DIGEST_BACKFILL_ACTIVATION = 'saved_job_backfill';

/**
 * Whether one account gets the backfilled activation, and why not when it does not.
 * @param {object|null} userData `users/{uid}` data
 * @param {object|null} subscriberData `newsletter_subscribers/{email}` data
 * @returns {{ activate: boolean, reason: string }}
 */
export function backfillDecision(userData, subscriberData) {
  if (!userData) return { activate: false, reason: 'no_user_doc' };
  if (!String(userData.email || '').trim()) return { activate: false, reason: 'no_email' };
  const choice = savedJobsDigestChoice(userData.savedJobsDigest);
  if (choice === 'off') return { activate: false, reason: 'opted_out' };
  if (choice === 'on') return { activate: false, reason: 'already_on' };
  if (!subscriberData) return { activate: false, reason: 'no_subscriber_record' };
  if (isCrossChannelStop(subscriberData)) return { activate: false, reason: 'cross_channel_stop' };
  return { activate: true, reason: 'activate' };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { getFirestoreDb } = await import('./lib/firestore-admin.mjs');
  const { FieldValue } = await import('firebase-admin/firestore');
  const db = await getFirestoreDb();

  const savedSnap = await db.collectionGroup('savedJobs').select().get();
  const uids = [...new Set(savedSnap.docs.map((d) => d.ref.parent.parent?.id).filter(Boolean))];
  console.log(`📌 ${uids.length} account(s) with ≥1 saved job — mode=${apply ? 'apply' : 'dry-run'}`);

  const counts = {};
  let written = 0;
  for (const uid of uids) {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() || {} : null;
    const email = String(userData?.email || '').trim().toLowerCase();
    const subSnap = email ? await db.collection('newsletter_subscribers').doc(email).get() : null;
    const subscriberData = subSnap?.exists ? subSnap.data() || {} : null;
    const { activate, reason } = backfillDecision(userData, subscriberData);
    counts[reason] = (counts[reason] || 0) + 1;
    if (!activate || !apply) continue;

    // Same race guard as the save path: re-read inside the transaction so a
    // concurrent unsubscribe or switch is never overwritten.
    const didWrite = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      if (savedJobsDigestChoice(fresh.exists ? (fresh.data() || {}).savedJobsDigest : null) !== 'undecided') return false;
      tx.set(userRef, {
        savedJobsDigest: {
          optedIn: true,
          optedInAt: FieldValue.serverTimestamp(),
          activationSource: SAVED_JOBS_DIGEST_BACKFILL_ACTIVATION,
        },
      }, { merge: true });
      return true;
    });
    if (didWrite) written += 1;
  }

  console.log('📊 Decisions:', JSON.stringify(counts));
  console.log(apply ? `✅ Activated ${written} account(s).` : `🧪 Dry-run: ${counts.activate || 0} account(s) would be activated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error('❌ Backfill failed:', e?.stack || e?.message || e);
    process.exit(1);
  });
}
