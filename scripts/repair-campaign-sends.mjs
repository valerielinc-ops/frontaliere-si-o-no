import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const allSentToday = JSON.parse(readFileSync('/tmp/all_sent_today.json', 'utf-8'));

const admin = (await import('firebase-admin')).default;
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const campaignId = 'weekly_2026-05-04';
const metaRef = db.collection('newsletter_subscribers').doc('_meta_');
const docRef = metaRef.collection('campaign_sends').doc(campaignId);

try {
  const snap = await docRef.get();
  const existing = new Set((snap.exists ? (snap.data().sentEmails || []) : []).map(e => e.toLowerCase()));
  console.log('Existing flagged:', existing.size);
  
  const newEmails = allSentToday.map(e => e.toLowerCase()).filter(e => !existing.has(e));
  console.log('New emails to add:', newEmails.length);
  
  await docRef.set({
    sentEmails: FieldValue.arrayUnion(...newEmails),
    lastRunAt: new Date('2026-05-04T05:08:00Z'),
    updatedAt: new Date(),
    repairedAt: new Date(),
  }, { merge: true });
  
  const v = await docRef.get();
  console.log('Verified in Firestore:', (v.data()?.sentEmails || []).length, 'emails flagged');
} catch(e) {
  console.error('FAILED:', e.code, e.message);
}

process.exit(0);
