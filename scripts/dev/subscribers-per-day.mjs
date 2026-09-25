#!/usr/bin/env node
import admin from 'firebase-admin';

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

const DAYS = parseInt(process.env.DAYS || '30', 10);
const now = new Date();
const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
cutoff.setHours(0, 0, 0, 0);

const snap = await db.collection('newsletter_subscribers').get();

const counts = new Map();
let withoutDate = 0;
let metaSkipped = 0;
let total = 0;

for (const doc of snap.docs) {
  if (doc.id === '_meta_') { metaSkipped++; continue; }
  total++;
  const row = doc.data();
  const toDate = (v) => {
    if (!v) return null;
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch { return null; } }
    if (v instanceof Date) return v;
    if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
    return null;
  };
  const ts =
    toDate(row.created_at) ||
    toDate(row.createdAt) ||
    toDate(row.subscribed_at) ||
    toDate(row.subscribedAt) ||
    toDate(row.confirmed_at) ||
    toDate(row.confirmedAt);
  if (!ts || isNaN(ts.getTime())) { withoutDate++; continue; }
  if (ts < cutoff) continue;
  const key = ts.toISOString().slice(0, 10);
  counts.set(key, (counts.get(key) || 0) + 1);
}

const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

console.log(`\nNewsletter subscribers per day — last ${DAYS} days`);
console.log(`(today: ${now.toISOString().slice(0, 10)}, cutoff: ${cutoff.toISOString().slice(0, 10)})\n`);
console.log('date         count');
console.log('----------   -----');
let sum = 0;
for (const [date, count] of sorted) {
  console.log(`${date}   ${String(count).padStart(5)}`);
  sum += count;
}
console.log('----------   -----');
console.log(`total in window: ${sum}`);
console.log(`\ndocs scanned: ${total} (skipped _meta_: ${metaSkipped}, no date: ${withoutDate})`);
process.exit(0);
