#!/usr/bin/env node
/**
 * Backfill `newsletter_subscribers/{email}` documents for the Auth users
 * that One Tap created without a corresponding subscriber record between
 * 2026-04-21 (when ea096801e7 fixed the GSI loader) and the deploy of the
 * persistOneTapSubscriber fix.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/backfill-onetap-orphan-subscribers.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/backfill-onetap-orphan-subscribers.mjs --apply
 *
 * Default is dry-run — prints the planned writes and a per-day summary.
 * Pass `--apply` to actually write to Firestore.
 *
 * Each backfilled doc mirrors the `auth_google` source channel that the
 * App.tsx auto-subscribe useEffect would have written, with `created_at`
 * pinned to the Auth user's `metadata.creationTime` so the daily numbers
 * line up with the Auth tab.
 */
import admin from 'firebase-admin';

const APPLY = process.argv.includes('--apply');

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

console.log(APPLY ? '🟢 APPLY mode — will write to Firestore' : '🟡 DRY RUN — no writes (pass --apply to commit)');

// ─── Pull both sides ───────────────────────────────────────
const authUsers = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  authUsers.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const subSnap = await db.collection('newsletter_subscribers').get();
const existingEmails = new Set(
  subSnap.docs
    .filter((d) => d.id !== '_meta_')
    .map((d) => (d.data().email || d.id || '').toLowerCase())
    .filter(Boolean),
);

// ─── Identify orphans (Auth user, no subscriber doc, Google provider) ───
const orphans = authUsers.filter((u) => {
  if (!u.email) return false;
  if (existingEmails.has(u.email.toLowerCase())) return false;
  const provs = (u.providerData || []).map((p) => p.providerId);
  // Restrict to google.com — leaves the 3 password-only edge cases for manual review.
  return provs.includes('google.com');
});

console.log(`\n${orphans.length} Google-OneTap-orphan Auth users to backfill\n`);

// Per-day preview
const byDay = new Map();
for (const u of orphans) {
  const ts = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
  if (!ts) continue;
  const k = ts.toISOString().slice(0, 10);
  byDay.set(k, (byDay.get(k) || 0) + 1);
}
console.log('Per-day distribution:');
for (const [d, n] of [...byDay.entries()].sort()) {
  console.log(`  ${d}   ${n}`);
}

if (orphans.length === 0) process.exit(0);

// ─── Write (or preview) ────────────────────────────────────
let written = 0;
let failed = 0;
const batchSize = 400;
for (let i = 0; i < orphans.length; i += batchSize) {
  const slice = orphans.slice(i, i + batchSize);
  const batch = APPLY ? db.batch() : null;
  for (const u of slice) {
    const email = u.email.toLowerCase().trim();
    const created = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : new Date();
    const lastSignIn = u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime) : created;
    const displayName = u.displayName || null;
    const nameParts = displayName ? displayName.split(' ') : [];

    const doc = {
      email,
      auth_uid: u.uid,
      auth_provider: 'google',
      name: displayName,
      firstName: nameParts[0] || null,
      lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : null,
      photoURL: u.photoURL || null,
      preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
      source: 'signup',
      source_channel: 'auth_google',
      source_cta: 'one_tap_backfill',
      source_component: 'auth_one_tap',
      locale: 'it-IT',
      preferred_locale: 'it',
      isActive: true,
      active: true,
      status: 'confirmed', // auth_google is in CONFIRMED_NEWSLETTER_SOURCES
      created_at: Timestamp.fromDate(created),
      subscribed_at: Timestamp.fromDate(created),
      confirmed_at: Timestamp.fromDate(created),
      lastLoginAt: Timestamp.fromDate(lastSignIn),
      updatedAt: FieldValue.serverTimestamp(),
      backfilled_at: FieldValue.serverTimestamp(),
      backfill_reason: 'one_tap_orphan_2026_04_21',
    };

    if (APPLY && batch) {
      batch.set(db.collection('newsletter_subscribers').doc(email), doc, { merge: true });
    } else if (i < batchSize && written < 5) {
      console.log(`  preview → ${email} (created ${created.toISOString().slice(0, 10)}, name=${displayName || '∅'})`);
    }
    written++;
  }
  if (APPLY && batch) {
    try {
      await batch.commit();
      process.stdout.write(`  batch ${i / batchSize + 1}: ${slice.length} written\n`);
    } catch (err) {
      failed += slice.length;
      console.error(`  batch ${i / batchSize + 1} failed:`, err.message);
    }
  }
}

console.log(`\n${APPLY ? 'Wrote' : 'Would write'} ${written - failed}/${orphans.length} subscriber docs${failed ? ` (${failed} failed)` : ''}`);
if (!APPLY) console.log('\nRe-run with --apply to commit.');
process.exit(0);
