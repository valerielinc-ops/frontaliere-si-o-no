#!/usr/bin/env node
import admin from 'firebase-admin';

if (!admin.apps?.length) {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();
const auth = admin.auth();

const DAYS = parseInt(process.env.DAYS || '30', 10);
const now = new Date();
const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
cutoff.setHours(0, 0, 0, 0);

// ─── 1. Pull all Auth users ────────────────────────────────
console.log('Pulling Firebase Auth users…');
const authUsers = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  authUsers.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);
console.log(`  ${authUsers.length} auth users total`);

// ─── 2. Pull all newsletter_subscribers ────────────────────
console.log('Pulling newsletter_subscribers…');
const subSnap = await db.collection('newsletter_subscribers').get();
const subs = subSnap.docs
  .filter((d) => d.id !== '_meta_')
  .map((d) => ({ id: d.id, ...d.data() }));
console.log(`  ${subs.length} subscriber docs total`);

const toDate = (v) => {
  if (!v) return null;
  if (typeof v.toDate === 'function') { try { return v.toDate(); } catch { return null; } }
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
  return null;
};
const subDate = (r) =>
  toDate(r.created_at) || toDate(r.createdAt) || toDate(r.subscribed_at) || toDate(r.subscribedAt);

// ─── 3. Per-day buckets ───────────────────────────────────
const authByDay = new Map();
const subByDay = new Map();

let authNoDate = 0;
for (const u of authUsers) {
  const ts = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
  if (!ts || isNaN(ts)) { authNoDate++; continue; }
  if (ts < cutoff) continue;
  const k = ts.toISOString().slice(0, 10);
  authByDay.set(k, (authByDay.get(k) || 0) + 1);
}

let subNoDate = 0;
for (const r of subs) {
  const ts = subDate(r);
  if (!ts) { subNoDate++; continue; }
  if (ts < cutoff) continue;
  const k = ts.toISOString().slice(0, 10);
  subByDay.set(k, (subByDay.get(k) || 0) + 1);
}

const allDays = [...new Set([...authByDay.keys(), ...subByDay.keys()])].sort();

console.log(`\nDaily comparison — last ${DAYS} days (today ${now.toISOString().slice(0,10)})\n`);
console.log('date         auth   newsletter   delta');
console.log('----------   ----   ----------   -----');
let aSum = 0, sSum = 0;
for (const d of allDays) {
  const a = authByDay.get(d) || 0;
  const s = subByDay.get(d) || 0;
  aSum += a; sSum += s;
  const delta = s - a;
  console.log(`${d}   ${String(a).padStart(4)}   ${String(s).padStart(10)}   ${delta >= 0 ? '+' : ''}${delta}`);
}
console.log('----------   ----   ----------   -----');
console.log(`total       ${String(aSum).padStart(5)}   ${String(sSum).padStart(10)}   ${sSum-aSum >= 0 ? '+' : ''}${sSum - aSum}`);

// ─── 4. Cross-reference ───────────────────────────────────
console.log('\n─── Cross-reference (full collection, not just window) ───');
const authEmails = new Set(authUsers.map((u) => (u.email || '').toLowerCase()).filter(Boolean));
const subEmails = new Set(subs.map((s) => (s.email || s.id || '').toLowerCase()).filter(Boolean));

let inBoth = 0, onlyAuth = 0, onlySub = 0, authNoEmail = 0;
for (const u of authUsers) {
  if (!u.email) { authNoEmail++; continue; }
  if (subEmails.has(u.email.toLowerCase())) inBoth++;
  else onlyAuth++;
}
for (const e of subEmails) {
  if (!authEmails.has(e)) onlySub++;
}

console.log(`  total auth users:                ${authUsers.length}`);
console.log(`    └ no email (anonymous/phone):  ${authNoEmail}`);
console.log(`  total subscriber docs:           ${subs.length}`);
console.log(`  in BOTH (auth ∩ subscribers):    ${inBoth}`);
console.log(`  only in Auth (no newsletter):    ${onlyAuth}`);
console.log(`  only in Newsletter (no auth):    ${onlySub}`);

// ─── 5. Subscriber breakdown by source_channel ────────────
const bySource = new Map();
for (const r of subs) {
  const k = r.source_channel || r.source || '(unknown)';
  bySource.set(k, (bySource.get(k) || 0) + 1);
}
console.log('\nSubscribers by source_channel:');
for (const [k, n] of [...bySource.entries()].sort((a,b) => b[1]-a[1])) {
  console.log(`  ${String(k).padEnd(28)} ${n}`);
}

// ─── 6. Subscriber breakdown by status / unsubscribe ──────
let unsubscribed = 0, statusConfirmed = 0, statusPending = 0, statusOther = 0;
for (const r of subs) {
  if (r.unsubscribedAt || r.unsubscribed_at) unsubscribed++;
  if (r.status === 'confirmed') statusConfirmed++;
  else if (r.status === 'pending') statusPending++;
  else statusOther++;
}
console.log('\nSubscriber status:');
console.log(`  status=confirmed:    ${statusConfirmed}`);
console.log(`  status=pending:      ${statusPending}`);
console.log(`  status=other/none:   ${statusOther}`);
console.log(`  has unsubscribedAt:  ${unsubscribed}`);

// ─── 7. Auth providers breakdown ──────────────────────────
const byProvider = new Map();
for (const u of authUsers) {
  const provs = (u.providerData || []).map((p) => p.providerId);
  const key = provs.length ? provs.sort().join('+') : 'password-or-anon';
  byProvider.set(key, (byProvider.get(key) || 0) + 1);
}
console.log('\nAuth users by provider:');
for (const [k, n] of [...byProvider.entries()].sort((a,b) => b[1]-a[1])) {
  console.log(`  ${String(k).padEnd(28)} ${n}`);
}

console.log(`\n(skipped: auth no-creation-date=${authNoDate}, subs no-date=${subNoDate})`);
process.exit(0);
