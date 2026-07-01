#!/usr/bin/env node
/**
 * Merge the two `newsletter_subscribers` docs whose email field/doc-id was
 * stored as an RFC5322 "Display Name <email>" string instead of a bare
 * address (historical bad data — no live write path produces this today).
 *
 * Each malformed doc is a duplicate of an already-legitimate subscriber doc
 * keyed by the bare, lowercased email (which also already has a matching
 * Firebase Auth account). Because `send-newsletter.mjs` sends to
 * `subscriber.email` verbatim and mail providers accept "Name <email>" as a
 * valid mailbox, both docs were independently receiving the newsletter —
 * this consolidates them into the one real subscriber doc.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/merge-malformed-subscriber-duplicates.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=… node scripts/dev/merge-malformed-subscriber-duplicates.mjs --apply
 *
 * Default is dry-run — prints the planned merge. Pass `--apply` to commit.
 */
import admin from 'firebase-admin';

const APPLY = process.argv.includes('--apply');

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

console.log(APPLY ? '🟢 APPLY mode — will write to Firestore' : '🟡 DRY RUN — no writes (pass --apply to commit)');

const MALFORMED_PATTERN = /^(.*)<([^>]+)>$/;
const SUBCOLLECTIONS = ['campaign_deliveries', 'events'];

const snap = await db.collection('newsletter_subscribers').get();
const malformed = snap.docs.filter((d) => MALFORMED_PATTERN.test(d.id));

console.log(`${snap.size} newsletter_subscribers docs, ${malformed.length} with a malformed "Name <email>" doc id`);

for (const badDoc of malformed) {
  const match = badDoc.id.match(MALFORMED_PATTERN);
  const cleanEmail = match[2].trim().toLowerCase();
  const cleanRef = db.collection('newsletter_subscribers').doc(cleanEmail);
  const cleanSnap = await cleanRef.get();

  if (!cleanSnap.exists) {
    console.log(`  ⚠️  ${badDoc.id} → no clean doc at ${cleanEmail}; skipping (needs manual review)`);
    continue;
  }

  console.log(`\n${badDoc.id} → merging into ${cleanEmail}`);

  for (const col of SUBCOLLECTIONS) {
    const badSub = await badDoc.ref.collection(col).get();
    const cleanSub = await cleanRef.collection(col).get();
    const cleanIds = new Set(cleanSub.docs.map((d) => d.id));
    const toCopy = badSub.docs.filter((d) => !cleanIds.has(d.id));
    console.log(`  ${col}: ${badSub.size} on malformed doc, ${toCopy.length} to copy (${badSub.size - toCopy.length} already present)`);

    if (APPLY) {
      for (const subDoc of toCopy) {
        await cleanRef.collection(col).doc(subDoc.id).set(subDoc.data());
      }
    }
  }

  if (APPLY) {
    await deleteDocWithSubcollections(badDoc.ref);
    console.log(`  ✅ deleted malformed doc ${badDoc.id}`);
  }
}

console.log(APPLY ? '\nDone.' : '\nRe-run with --apply to commit.');

async function deleteDocWithSubcollections(ref) {
  for (const col of SUBCOLLECTIONS) {
    const sub = await ref.collection(col).get();
    const batch = db.batch();
    sub.docs.forEach((d) => batch.delete(d.ref));
    if (sub.size > 0) await batch.commit();
  }
  await ref.delete();
}
