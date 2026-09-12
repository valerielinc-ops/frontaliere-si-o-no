#!/usr/bin/env node
/**
 * REPORT ONLY — inventory Auth users that One Tap created without a
 * corresponding newsletter subscriber record.
 *
 * Authentication is not newsletter consent. This command intentionally cannot
 * create or promote newsletter_subscribers documents: the historical
 * `--apply` mode would have recreated the silent-auth bug by writing
 * `status: 'confirmed'` without a displayed consent proof.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/backfill-onetap-orphan-subscribers.mjs
 *
 * Passing `--apply` is rejected so an old operational runbook cannot turn this
 * read-only inventory back into a consent bypass.
 */
import admin from 'firebase-admin';

if (process.argv.includes('--apply')) {
  console.error('Refusing --apply: One Tap authentication is not newsletter consent; this inventory is report-only.');
  process.exit(2);
}

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const auth = admin.auth();

console.log('🔎 READ-ONLY — no newsletter records will be created');

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

console.log(`\n${orphans.length} Google-OneTap-orphan Auth users found\n`);

// Per-day summary without printing personal addresses.
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

console.log('\nNo newsletter record was created. An explicit communications form and, where applicable, DOI is required.');
process.exit(0);
