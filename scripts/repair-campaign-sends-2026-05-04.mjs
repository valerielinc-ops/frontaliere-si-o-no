/**
 * One-time repair: marks the 350 subscribers who received the weekly_2026-05-04
 * newsletter via local send (that ran without Firestore write access) as sent,
 * so the daily workflow doesn't send them a duplicate.
 *
 * Safe to run multiple times (arrayUnion is idempotent).
 * Delete this file after the repair is confirmed.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const admin = (await import('firebase-admin')).default;
if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const CAMPAIGN_ID = 'weekly_2026-05-04';
const BATCH_WINDOW_START = new Date('2026-05-04T04:50:00Z');

// Identify subscribers sent to today by querying last_sent_at
const cutoff = admin.firestore.Timestamp.fromDate(BATCH_WINDOW_START);
const snap = await db.collection('newsletter_subscribers')
  .where('last_sent_at', '>=', cutoff)
  .get();

const sentToday = snap.docs
  .filter(d => d.id !== '_meta_' && d.id.includes('@'))
  .map(d => d.id.toLowerCase());

console.log(`Found ${sentToday.length} subscribers with last_sent_at >= ${BATCH_WINDOW_START.toISOString()}`);

const docRef = db.collection('newsletter_subscribers').doc('_meta_')
  .collection('campaign_sends').doc(CAMPAIGN_ID);

const existing = await docRef.get();
const existingEmails = existing.exists ? (existing.data().sentEmails || []) : [];
console.log(`Existing in campaign_sends: ${existingEmails.length}`);

const toAdd = sentToday.filter(e => !existingEmails.includes(e));
console.log(`Adding ${toAdd.length} new emails to campaign_sends`);

if (toAdd.length > 0) {
  await docRef.set({
    sentEmails: FieldValue.arrayUnion(...toAdd),
    lastRunAt: new Date('2026-05-04T05:08:00Z'),
    updatedAt: new Date(),
    repairedAt: new Date(),
  }, { merge: true });
}

const verified = await docRef.get();
console.log(`Verified: ${(verified.data()?.sentEmails || []).length} emails flagged in campaign_sends`);
