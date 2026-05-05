#!/usr/bin/env node
import admin from 'firebase-admin';
if (!admin.apps?.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const snap = await db.collection('newsletter_subscribers').limit(8).get();
const fieldFreq = new Map();

for (const doc of snap.docs) {
  if (doc.id === '_meta_') continue;
  const row = doc.data();
  console.log('---', doc.id, '---');
  for (const [k, v] of Object.entries(row)) {
    fieldFreq.set(k, (fieldFreq.get(k) || 0) + 1);
    let display;
    if (v && typeof v.toDate === 'function') {
      try { display = `<Timestamp ${v.toDate().toISOString()}>`; } catch { display = '<Timestamp invalid>'; }
    } else if (v instanceof Date) display = `<Date ${v.toISOString()}>`;
    else if (typeof v === 'object') display = JSON.stringify(v).slice(0, 120);
    else display = String(v).slice(0, 120);
    console.log(`  ${k}: ${display}`);
  }
}

console.log('\nField frequency (sample of 8):');
for (const [k, n] of [...fieldFreq.entries()].sort((a,b) => b[1]-a[1])) console.log(`  ${k}: ${n}`);

// Now scan all and tally which date-ish fields exist
const allSnap = await db.collection('newsletter_subscribers').get();
const dateFields = ['createdAt','created_at','subscribedAt','signupDate','timestamp','updatedAt','updated_at','confirmedAt','date'];
const counts = Object.fromEntries(dateFields.map(f => [f, 0]));
let total = 0;
for (const d of allSnap.docs) {
  if (d.id === '_meta_') continue;
  total++;
  const r = d.data();
  for (const f of dateFields) if (r[f] !== undefined && r[f] !== null) counts[f]++;
}
console.log(`\nDate-ish field presence across ${total} docs:`);
for (const [f, n] of Object.entries(counts)) console.log(`  ${f}: ${n}`);
process.exit(0);
