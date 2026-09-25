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
 * mailbox is alive — AND `classifySuppressionDecay()` does not call the doc
 * `terminal` (structured `bounce_severity: 'hard'`, an unambiguous hard-bounce
 * reason, a complaint/opt-out stamp, or an exhausted re-probe budget). Never-
 * delivered subscribers and terminal ones are left untouched, to avoid burning
 * sender reputation on the 5 free-tier ESPs on a real dead list.
 *
 * The restored STATUS is consent-aware (`recoveredStatus()`): a subscriber who
 * was still `pending` when the bounce landed comes back `pending`, not
 * `confirmed`. The 2026-07-01 run below predates that rule and wrote
 * `confirmed` unconditionally; the rule was worked out afterwards in
 * scripts/restore-mailtrap-suspension-suppressions.mjs and generalised into
 * scripts/lib/suppressionDecay.mjs, and this script now reads it from there so
 * a future re-run cannot regress to the older behaviour.
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
// The hard-bounce/human gate, no longer a bare regex test here.
//
// This script used to decide "is this an unambiguous hard bounce?" with
// `HARD_BOUNCE_PATTERN.test(bounce_reason)` and NOTHING else — the same
// regex-only reading that scripts/lib/suppressionDecay.mjs documents as a live
// defect: `maybeEscalateSoftBounce()` writes `bounce_severity: 'hard'` with a
// reason string ("<reason> (escalated after N consecutive soft rejects)")
// containing none of the regex's phrases, and those docs mostly DO have
// historical deliveries — so the proof-of-life test above passes and the
// regex below misses, and this script would reactivate a suppression that
// exists on purpose to protect the sending domain.
//
// `classifySuppressionDecay()` reads the STRUCTURED `bounce_severity` field
// first and falls back to the regex only for pre-classifier documents, and it
// also covers the opt-out/complaint stamps this script never looked at. Same
// gate, same module, as scripts/restore-mailtrap-suspension-suppressions.mjs
// and scripts/suppression-decay.mjs — one answer to "may this address come
// back?", not three that drift.
import { classifySuppressionDecay, maskAddress, publishableReason, recoveredStatus } from '../lib/suppressionDecay.mjs';

const APPLY = process.argv.includes('--apply');

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

console.log(APPLY ? '🟢 APPLY mode — will write to Firestore' : '🟡 DRY RUN — no writes (pass --apply to commit)');

const subSnap = await db.collection('newsletter_subscribers').where('status', '==', 'bounced').get();
const bounced = subSnap.docs.filter((d) => d.id !== '_meta_');

console.log(`\n${bounced.length} bounced newsletter_subscribers docs found\n`);

const nowMs = Date.now();
const candidates = [];
let neverDelivered = 0;
const excludedTerminal = {};

for (const doc of bounced) {
  const data = doc.data();
  const everDelivered = !!data.last_delivered_at;
  const everOpened = Number(data.open_count) > 0;
  const reason = String(data.bounce_reason || '');

  // Terminal FIRST: a hard bounce or a human decision outranks every piece of
  // "the mailbox is alive" evidence there is — being alive is precisely why a
  // complainer told us to stop, and a mailbox that accepted mail last year can
  // still have been deleted since.
  const verdict = classifySuppressionDecay(data, nowMs);
  if (verdict.tier === 'terminal') {
    excludedTerminal[verdict.code] = (excludedTerminal[verdict.code] || 0) + 1;
    continue;
  }
  if (!everDelivered && !everOpened) {
    neverDelivered++;
    continue;
  }
  candidates.push({ id: doc.id, ref: doc.ref, data, reason, everDelivered, everOpened });
}

// Consent evidence needs the event log, so it is read only for the docs that
// survived the gates above — never for the whole collection.
for (const c of candidates) {
  const evSnap = await c.ref.collection('events').get();
  const events = evSnap.docs.map((e) => e.data() || {});
  // NOT an unconditional `confirmed`. The 2026-07-01 run of this script
  // predates the consent rule and wrote `confirmed` to every candidate; a
  // subscriber still `pending` when the bounce landed would be promoted to a
  // consent they never gave, which is worse than the bug being repaired.
  // `pending` subscribers routinely have `last_delivered_at` set — the
  // double-opt-in email itself was delivered — so proof of life does not
  // protect against this on its own.
  c.restoredStatus = recoveredStatus('newsletter_subscribers', c.data, events);
}

const confirmedCount = candidates.filter((c) => c.restoredStatus === 'confirmed').length;
console.log(`Reactivation candidates (probable false positives): ${candidates.length}`);
console.log(`  → to 'confirmed' (positive consent evidence): ${confirmedCount}`);
console.log(`  → to 'pending' (no consent evidence, still owes double opt-in): ${candidates.length - confirmedCount}`);
console.log(`  excluded — never delivered nor opened: ${neverDelivered}`);
for (const [code, count] of Object.entries(excludedTerminal).sort((a, b) => b[1] - a[1])) {
  console.log(`  excluded — terminal (${code}): ${count}`);
}

// Masked + redacted: doc ids here ARE addresses, and reason strings carry them
// too ("<…@icloud.com>: user is over quota" was observed in production). This
// output gets pasted into issues and PRs — AGENTS.md Privacy.
console.log('\nPreview (first 10):');
for (const c of candidates.slice(0, 10)) {
  console.log(`  ${maskAddress(c.data?.email || c.id)} — reason="${publishableReason(c.reason)}" delivered=${c.everDelivered} opened=${c.everOpened} → ${c.restoredStatus}`);
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
      // `isActive`/`active` follow the RESTORED status, not a blanket true: a
      // doc coming back as `pending` is not an active subscriber, it is one
      // that still owes a double opt-in. Same shape as recoveryFields() in
      // scripts/suppression-decay.mjs.
      const fullyMailable = c.restoredStatus !== 'pending';
      batch.set(c.ref, {
        status: c.restoredStatus,
        isActive: fullyMailable,
        active: fullyMailable,
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
