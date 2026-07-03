#!/usr/bin/env node
/**
 * One-time remediation for the 2223 `newsletter_subscribers` docs that were
 * marked `bounced` before the hard/soft bounce classifier existed (see
 * functions/src/lib/bounceClassification.js) — back then every provider
 * signal (including reputation-based soft rejects) wrote the same permanent
 * `status: 'bounced'`, which is excluded from every future send.
 *
 * This reactivates ONLY the subset showing strong evidence of being a false
 * positive: the subscriber has previously and successfully received mail
 * (last_delivered_at set) or engaged with it (open_count > 0) — proving the
 * mailbox is alive — AND the recorded bounce_reason is not an unambiguous
 * hard-bounce signal (mailbox genuinely doesn't exist / is disabled). Never-
 * delivered subscribers and unambiguous hard bounces are left untouched, to
 * avoid burning sender reputation on the 5 free-tier ESPs on a real dead list.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/reactivate-false-positive-bounces.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/reactivate-false-positive-bounces.mjs --apply
 *
 * Default is dry-run — prints the reactivation candidates and a summary.
 * Pass `--apply` to actually write to Firestore.
 *
 * Status (#3206 item 1): ran with --apply in production on 2026-07-01
 * ~09:11 UTC — 2017 newsletter_subscribers docs reactivated (confirmed via
 * bounce_reactivated_at timestamp). Re-run in dry-run mode on 2026-07-02
 * shows 0 remaining candidates (357 bounced docs left, all correctly
 * excluded as never-delivered or unambiguous hard bounces). Safe to re-run
 * any time (idempotent no-op once the backlog is cleared); left in place
 * for any future one-off catch-up need.
 */
import admin from 'firebase-admin';

const APPLY = process.argv.includes('--apply');

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Unambiguous hard-bounce signals — the mailbox itself is gone/rejecting
// permanently. Never reactivate on these, regardless of prior engagement.
const HARD_BOUNCE_PATTERN = /does not exist|no such user|no such mailbox|user unknown|unknown user|invalid recipient|invalid mailbox|mailbox not found|mailbox unavailable|recipient rejected|address rejected|nonexistent|non-?existent|account.*disabled|disabled account|550[ -]?5\.1\.1|550[ -]?5\.1\.10|user doesn'?t exist/i;

console.log(APPLY ? '🟢 APPLY mode — will write to Firestore' : '🟡 DRY RUN — no writes (pass --apply to commit)');

const subSnap = await db.collection('newsletter_subscribers').where('status', '==', 'bounced').get();
const bounced = subSnap.docs.filter((d) => d.id !== '_meta_');

console.log(`\n${bounced.length} bounced newsletter_subscribers docs found\n`);

const candidates = [];
let neverDelivered = 0;
let hardReason = 0;

for (const doc of bounced) {
  const data = doc.data();
  const everDelivered = !!data.last_delivered_at;
  const everOpened = Number(data.open_count) > 0;
  const reason = String(data.bounce_reason || '');

  if (!everDelivered && !everOpened) {
    neverDelivered++;
    continue;
  }
  if (HARD_BOUNCE_PATTERN.test(reason)) {
    hardReason++;
    continue;
  }
  candidates.push({ id: doc.id, ref: doc.ref, reason, everDelivered, everOpened });
}

console.log(`Reactivation candidates (probable false positives): ${candidates.length}`);
console.log(`  excluded — never delivered nor opened: ${neverDelivered}`);
console.log(`  excluded — unambiguous hard-bounce reason: ${hardReason}`);

console.log('\nPreview (first 10):');
for (const c of candidates.slice(0, 10)) {
  console.log(`  ${c.id} — reason="${c.reason}" delivered=${c.everDelivered} opened=${c.everOpened}`);
}

if (candidates.length === 0) {
  console.log('\nNothing to reactivate.');
  process.exit(0);
}

let reactivated = 0;
let failed = 0;
// Two writes per candidate (subscriber doc + events entry) — keep well under
// Firestore's 500-writes-per-batch limit.
const batchSize = 200;

if (APPLY) {
  for (let i = 0; i < candidates.length; i += batchSize) {
    const slice = candidates.slice(i, i + batchSize);
    const batch = db.batch();
    for (const c of slice) {
      batch.set(c.ref, {
        status: 'confirmed',
        isActive: true,
        active: true,
        soft_bounce_count: 0,
        previous_bounce_reason: c.reason,
        bounce_reactivated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(c.ref.collection('events').doc(), {
        event_type: 'bounce_reactivated',
        reason: `probable false positive (delivered=${c.everDelivered}, opened=${c.everOpened}): ${c.reason}`,
        timestamp: FieldValue.serverTimestamp(),
      });
      reactivated++;
    }
    try {
      await batch.commit();
      process.stdout.write(`  batch ${Math.floor(i / batchSize) + 1}: ${slice.length} reactivated\n`);
    } catch (err) {
      failed += slice.length;
      reactivated -= slice.length;
      console.error(`  batch ${Math.floor(i / batchSize) + 1} failed:`, err.message);
    }
  }
}

console.log(`\n${APPLY ? 'Reactivated' : 'Would reactivate'} ${candidates.length - failed}/${candidates.length}${failed ? ` (${failed} failed)` : ''}`);
if (!APPLY) console.log('\nRe-run with --apply to commit.');
process.exit(0);
