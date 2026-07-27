#!/usr/bin/env node
/**
 * Mailtrap suppression retry runner.
 *
 * Root cause + policy: see scripts/lib/mailtrapSuppressionRetry.mjs. Mailtrap
 * permanently suppresses an address on its first "hard bounce" — the
 * evidenced dominant cause is `message_bounce_category: "Over quota"` (a full
 * mailbox, SMTP 4.2.2), a TEMPORARY condition Mailtrap never auto-retries.
 *
 * Eligibility uses ONLY our own Firestore data (see the classifier docstring
 * for why: Mailtrap's Suppressions API proved unreliable at listing/
 * classifying the backlog when tested live). For each `status: 'suppressed'`
 * subscriber suppressed longer than the grace period:
 *   1. Look up + remove the Mailtrap-side suppression if the API can find it
 *      (best-effort — if not found, proceed anyway; see module docstring).
 *   2. Flip Firestore status back to `pending` so the cascade can genuinely
 *      redeliver. If the mailbox is still full, the existing webhook
 *      naturally re-flips status to `suppressed` on the next bounce —
 *      self-healing, no extra bookkeeping needed here.
 *
 * `complained`/`unsubscribed` subscribers are a different Firestore status
 * entirely (see functions/src/newsletterMailtrapWebhookCore.js) and are never
 * touched by this script.
 *
 * Usage:
 *   node scripts/mailtrap-suppression-retry.mjs            # DRY-RUN (no writes, no API mutation)
 *   node scripts/mailtrap-suppression-retry.mjs --apply    # un-suppress + reactivate eligible
 *
 * Requires MAILTRAP_API_TOKEN (CI: load-rc-env.mjs) and Firebase
 * application-default credentials.
 */
import { commitInChunks } from './lib/firestore-batch.mjs';
import {
  fetchMailtrapAccountId,
  findSuppression,
  deleteSuppression,
  sleep,
  MIN_API_CALL_INTERVAL_MS,
} from './lib/mailtrapSuppressionsApi.mjs';
import { isRetryable, MAX_REACTIVATIONS_PER_RUN } from './lib/mailtrapSuppressionRetry.mjs';

const APPLY = process.argv.includes('--apply');

let db;

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
}

async function main() {
  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) {
    console.error('❌ MAILTRAP_API_TOKEN not set');
    process.exit(1);
  }

  await initFirebase();
  const { FieldValue } = await import('firebase-admin/firestore');
  const now = Date.now();

  const accountId = await fetchMailtrapAccountId(token);
  if (!accountId) {
    console.error('❌ Could not resolve Mailtrap account id');
    process.exit(1);
  }

  const snap = await db.collection('newsletter_subscribers').where('status', '==', 'suppressed').get();
  const suppressed = [];
  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    suppressed.push({ ref: doc.ref, email: String(doc.data()?.email || doc.id).toLowerCase(), data: doc.data() });
  });
  console.log(`📊 ${suppressed.length} subscriber(s) with status=suppressed in Firestore`);

  // Backfill suppressed_at for the pre-existing backlog (this field didn't
  // exist before this feature). `updated_at` is NOT a safe substitute — live
  // check 2026-07-22 found addresses first suppressed 34-37 days ago whose
  // `updated_at` was only 1-2 days old, because something keeps re-sending to
  // already-suppressed addresses (11-22 repeat `suppressed` events on single
  // addresses observed — a separate bug worth its own investigation). The
  // EARLIEST `suppressed`-type event in the subscriber's own event log is
  // immune to that: it only moves forward once, at the real first bounce.
  const missingBackfill = suppressed.filter((s) => !s.data.suppressed_at);
  if (missingBackfill.length) {
    console.log(`📊 Backfilling suppressed_at for ${missingBackfill.length} pre-existing doc(s) from event history`);
    const backfilled = [];
    for (const s of missingBackfill) {
      const evSnap = await s.ref.collection('events').where('event_type', '==', 'suppressed').get();
      const timestamps = evSnap.docs.map((d) => d.data().timestamp?.toDate?.()).filter(Boolean);
      if (!timestamps.length) continue;
      const firstSuppressedAt = new Date(Math.min(...timestamps.map((t) => t.getTime())));
      s.data.suppressed_at = firstSuppressedAt; // keep in-memory copy in sync for isRetryable() below
      backfilled.push({ ref: s.ref, at: firstSuppressedAt });
    }
    if (APPLY && backfilled.length) {
      await commitInChunks(db, backfilled, (batch, it) => {
        batch.set(it.ref, { suppressed_at: it.at }, { merge: true });
      });
    }
    console.log(`✅ Backfilled ${backfilled.length}/${missingBackfill.length} (rest had no event history — treated as unknown-age)`);
  }

  const eligible = suppressed.filter((s) => isRetryable(s.data, now));
  console.log(`📊 Retry-eligible (grace period expired): ${eligible.length}`);

  const toReactivate = eligible.slice(0, MAX_REACTIVATIONS_PER_RUN);
  if (eligible.length > toReactivate.length) {
    console.log(`⏳ ${eligible.length - toReactivate.length} eligible reactivation(s) deferred to next run (cap=${MAX_REACTIVATIONS_PER_RUN})`);
  }

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes, no API mutation. Re-run with --apply.');
    for (const s of toReactivate.slice(0, 10)) console.log(`   [retry] ${s.email}`);
    return;
  }

  const reactivated = [];
  const lastCallAt = {};
  const pacedCall = async (fn) => {
    const wait = lastCallAt.at ? Math.max(0, MIN_API_CALL_INTERVAL_MS - (Date.now() - lastCallAt.at)) : 0;
    if (wait) await sleep(wait);
    lastCallAt.at = Date.now();
    return fn();
  };

  // Commit progressively instead of once after the whole paced-API loop
  // finishes: at MAX_REACTIVATIONS_PER_RUN=800 the loop can run ~2.5h
  // worst-case, and a mid-run timeout/kill must not lose reactivations
  // already applied Mailtrap-side but not yet written back to Firestore.
  const COMMIT_CHUNK_SIZE = 100;
  let pendingCommit = [];
  const writeReactivation = (batch, it) => {
    batch.set(it.ref, {
      status: 'pending',
      isActive: true,
      active: true,
      reactivated_at: FieldValue.serverTimestamp(),
      mailtrap_suppression_resolved_at: FieldValue.serverTimestamp(),
      mailtrap_suppression_type: it.record?.type || null,
      mailtrap_suppression_category: it.record?.message_bounce_category || null,
    }, { merge: true });
  };
  const flushPending = async () => {
    if (!pendingCommit.length) return;
    await commitInChunks(db, pendingCommit, writeReactivation);
    pendingCommit = [];
  };

  for (const s of toReactivate) {
    let record = null;
    try {
      record = await pacedCall(() => findSuppression(token, accountId, s.email));
    } catch (e) {
      console.warn(`⚠️  suppression lookup failed for ${s.email}: ${e.message} — retrying reactivation anyway`);
    }
    if (record) {
      const deleted = await pacedCall(() => deleteSuppression(token, accountId, record.id));
      if (!deleted) {
        console.warn(`⚠️  failed to remove Mailtrap suppression for ${s.email} — left as suppressed, will retry next run`);
        continue;
      }
    }
    reactivated.push({ ref: s.ref, record });
    pendingCommit.push({ ref: s.ref, record });
    if (pendingCommit.length >= COMMIT_CHUNK_SIZE) await flushPending();
  }

  await flushPending();
  console.log(`✅ Un-suppressed + reactivated ${reactivated.length}/${toReactivate.length}`);
}

main().catch((err) => {
  console.error('[mailtrap-suppression-retry] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
