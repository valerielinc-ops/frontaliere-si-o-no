#!/usr/bin/env node
import admin from 'firebase-admin';
if (!admin.apps?.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const auth = admin.auth();

const authUsers = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  authUsers.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

const subSnap = await db.collection('newsletter_subscribers').get();
const subEmails = new Set(
  subSnap.docs
    .filter((d) => d.id !== '_meta_')
    .map((d) => (d.data().email || d.id || '').toLowerCase())
    .filter(Boolean)
);

// Auth-only users by day, split by provider
const onlyAuth = authUsers.filter((u) => u.email && !subEmails.has(u.email.toLowerCase()));

const byDayProv = new Map();
const totalByDay = new Map();
for (const u of onlyAuth) {
  const ts = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
  if (!ts) continue;
  const day = ts.toISOString().slice(0, 10);
  const provs = (u.providerData || []).map((p) => p.providerId).sort().join('+') || 'pwd';
  byDayProv.set(`${day}|${provs}`, (byDayProv.get(`${day}|${provs}`) || 0) + 1);
  totalByDay.set(day, (totalByDay.get(day) || 0) + 1);
}

const days = [...totalByDay.keys()].sort();
const cutoff = '2026-04-04';
console.log('Auth-only users (Auth account, NO newsletter doc) per day:\n');
console.log('date         total   google.com   linkedin   pwd   facebook');
console.log('----------   -----   ----------   --------   ---   --------');
for (const day of days) {
  if (day < cutoff) continue;
  const t = totalByDay.get(day);
  const g = byDayProv.get(`${day}|google.com`) || 0;
  const l = byDayProv.get(`${day}|oidc.linkedin`) || byDayProv.get(`${day}|linkedin.com`) || 0;
  const p = byDayProv.get(`${day}|pwd`) || byDayProv.get(`${day}|password`) || 0;
  const f = byDayProv.get(`${day}|facebook.com`) || 0;
  const others = t - g - l - p - f;
  console.log(
    `${day}   ${String(t).padStart(5)}   ${String(g).padStart(10)}   ${String(l).padStart(8)}   ${String(p).padStart(3)}   ${String(f).padStart(8)}${others ? `   (other: ${others})` : ''}`
  );
}

console.log(`\nTotal auth-only across full collection: ${onlyAuth.length}`);
console.log('\nProvider summary for auth-only users (all time):');
const allByProv = new Map();
for (const u of onlyAuth) {
  const provs = (u.providerData || []).map((p) => p.providerId).sort().join('+') || 'pwd';
  allByProv.set(provs, (allByProv.get(provs) || 0) + 1);
}
for (const [p, n] of [...allByProv.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(p).padEnd(28)} ${n}`);
}

// Pre/post April 21 comparison
const pivot = new Date('2026-04-21T00:00:00Z');
let preG = 0, postG = 0, preL = 0, postL = 0, prePwd = 0, postPwd = 0;
for (const u of onlyAuth) {
  const ts = u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
  if (!ts) continue;
  const provs = (u.providerData || []).map((p) => p.providerId).sort().join('+') || 'pwd';
  const isPost = ts >= pivot;
  if (provs === 'google.com') (isPost ? postG++ : preG++);
  else if (provs.includes('linkedin')) (isPost ? postL++ : preL++);
  else if (provs === 'pwd' || provs === 'password') (isPost ? postPwd++ : prePwd++);
}
console.log('\nAuth-only pivot at 2026-04-21:');
console.log(`  google.com:  pre=${preG}  post=${postG}`);
console.log(`  linkedin:    pre=${preL}  post=${postL}`);
console.log(`  password:    pre=${prePwd}  post=${postPwd}`);
process.exit(0);
