#!/usr/bin/env node
/**
 * One-off backfill: pin `frequencyOverride: true` on active
 * `job_alert_subscribers/{email}/alerts/{alertId}` docs that already carry
 * `frequency: 'daily'` but predate the adaptive-engagement engine
 * (PR #4275) and therefore have no `frequencyOverride` field at all.
 *
 * Without this, `resolveEffectiveJobAlertTier`
 * (scripts/lib/jobAlertEngagementTier.mjs) treats every one of these as
 * engine-managed — a subscriber who explicitly chose daily before the
 * engine existed gets silently re-tiered down to `every-other-day`/`weekly`
 * the moment they go quiet, with no signal they ever consented to that.
 * Pinning `frequencyOverride: true` here locks in the daily choice they
 * already made, matching the one-off manual fix already applied to
 * `kagedennis@gmail.com` (see PR #4275 body) — this just extends it to the
 * rest of the legacy base. Follow-up issue #4282, item 1.
 *
 * Reuses the existing collectionGroup('alerts') composite index
 * (active ASC, frequency ASC — firestore.indexes.json) so no new index
 * deploy is needed.
 *
 * Excludes docs carrying `backfilled_from` (set only by
 * functions/src/jobAlertBackfillCore.js, id `backfill-newsletter`): those
 * alerts were auto-created for newsletter subscribers who never used the
 * job-alert UI at all, so `frequency: 'daily'` there is a synthetic
 * default, not an explicit choice — pinning them would lock ~5k inferred
 * subscribers out of the adaptive engine entirely, the opposite of what
 * this backfill is for. Confirmed via a --dry-run count before this
 * exclusion was added: 4962/4962 candidates were `backfill-newsletter`
 * docs, 0 came from the real create-alert form or one-tap CTAs.
 *
 * Idempotent: skips docs where `frequencyOverride` is already set to any
 * value — `true` means already pinned; `false` means the user explicitly
 * reset to auto-engagement via handleResetToAuto and must NOT be overwritten.
 * Re-running is a no-op on already-patched docs.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/backfill-jobalert-legacy-daily-override.mjs [--dry-run]
 */

import { getFirestoreDb } from './lib/firestore-admin.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const db = await getFirestoreDb();
  const { FieldValue } = await import('firebase-admin/firestore');

  console.log(`🔎 Querying collectionGroup('alerts') active+daily${DRY_RUN ? ' (dry-run)' : ''}`);
  const snap = await db
    .collectionGroup('alerts')
    .where('active', '==', true)
    .where('frequency', '==', 'daily')
    .get();
  console.log(`   Found ${snap.size} active daily alerts`);

  let alreadyPinned = 0;
  let skippedUserReset = 0;
  let skippedInferred = 0;
  const refsToPatch = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.backfilled_from) {
      skippedInferred++;
      continue;
    }
    if ('frequencyOverride' in data) {
      if (data.frequencyOverride === true) alreadyPinned++;
      else skippedUserReset++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`   [dry] would pin ${doc.ref.path}`);
    }
    refsToPatch.push(doc.ref);
  }

  if (!DRY_RUN && refsToPatch.length > 0) {
    await commitInChunks(db, refsToPatch, (batch, ref) => {
      batch.set(ref, { frequencyOverride: true, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  console.log('');
  console.log(`   ✅ Pinned frequencyOverride:true : ${refsToPatch.length}${DRY_RUN ? ' (dry)' : ''}`);
  console.log(`   ⏭️  Already pinned               : ${alreadyPinned}`);
  console.log(`   ⏭️  Skipped (user reset-to-auto) : ${skippedUserReset}`);
  console.log(`   ⏭️  Skipped (inferred backfill)  : ${skippedInferred}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
