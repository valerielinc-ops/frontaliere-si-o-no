#!/usr/bin/env node
/**
 * Backfill Firebase Auth accounts for the existing `newsletter_subscribers`
 * docs that have none (~522 of 5241 — lead-capture gates like job_gate, popup,
 * lead_magnet, analysis_gate, calculator_paywall, offerwall, chatbot write
 * straight to Firestore via upsertNewsletterSubscriber and never touch Auth).
 *
 * Going forward the `syncNewsletterSubscriberAuth` onDocumentCreated trigger
 * (functions/index.js, functions/src/newsletterSubscriberAuthSync.js) closes
 * this gap for every NEW subscriber doc. This script is a one-time catch-up
 * for the docs that already existed before that trigger was deployed.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/backfill-newsletter-subscriber-auth.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/backfill-newsletter-subscriber-auth.mjs --apply
 *
 * Default is dry-run — prints the planned Auth-user creations and a summary.
 * Pass `--apply` to actually call admin.auth().createUser(...).
 *
 * Note: this intentionally duplicates the small amount of Admin SDK logic from
 * functions/src/newsletterSubscriberAuthSync.js rather than importing it —
 * this script runs standalone (node scripts/dev/*.mjs) outside the
 * `functions/` Firebase deploy bundle, and per repo precedent
 * (backfill-onetap-orphan-subscribers.mjs) the two deploy boundaries are kept
 * fully decoupled.
 */
import admin from 'firebase-admin';

const APPLY = process.argv.includes('--apply');

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const auth = admin.auth();

console.log(APPLY ? '🟢 APPLY mode — will create Auth users' : '🟡 DRY RUN — no writes (pass --apply to commit)');

// ─── Pull both sides ───────────────────────────────────────
const authUsers = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  authUsers.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const existingAuthEmails = new Set(
  authUsers.filter((u) => u.email).map((u) => u.email.toLowerCase()),
);

const subSnap = await db.collection('newsletter_subscribers').get();
const subscriberEmails = subSnap.docs
  .filter((d) => d.id !== '_meta_')
  .map((d) => (d.data().email || d.id || '').toLowerCase().trim())
  .filter(Boolean);

// De-dupe (a handful of docs may share an email via legacy doc ids).
const uniqueSubscriberEmails = [...new Set(subscriberEmails)];

// ─── Identify orphans (subscriber doc, no Auth user) ───
const orphans = uniqueSubscriberEmails.filter((email) => !existingAuthEmails.has(email));

console.log(`\n${uniqueSubscriberEmails.length} newsletter_subscribers docs, ${orphans.length} with no matching Auth user\n`);

if (orphans.length === 0) {
  console.log('Nothing to backfill.');
  process.exit(0);
}

console.log('Preview (first 5):');
for (const email of orphans.slice(0, 5)) {
  console.log(`  would create → ${email}`);
}

// ─── Create (or preview) ────────────────────────────────────
let created = 0;
let skipped = 0;
let errors = 0;

if (APPLY) {
  for (const email of orphans) {
    try {
      await auth.createUser({ email, emailVerified: false, disabled: false });
      created++;
    } catch (error) {
      if (error?.code === 'auth/email-already-exists') {
        // Raced with a concurrent write (e.g. the new trigger, or the user
        // signing up between the listUsers() snapshot and now) — not an error.
        skipped++;
      } else {
        errors++;
        console.error(`  error → ${email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

console.log(`\nSummary: ${orphans.length} orphans found`);
if (APPLY) {
  console.log(`  created: ${created}`);
  console.log(`  skipped (raced/already-exists): ${skipped}`);
  console.log(`  errors: ${errors}`);
} else {
  console.log(`  Would create: ${orphans.length}`);
  console.log('\nRe-run with --apply to commit.');
}
process.exit(0);
