/**
 * Publisher domain ownership verification (anti-abuse, Phase 3).
 *
 * A publisher proves it controls the company domain by adding a DNS TXT record.
 * Flow (authenticated publisher):
 *   1. First call → we mint + store a token and return the TXT record to add:
 *        host:  _frontaliereticino.<domain>
 *        value: frontaliereticino-verify=<token>
 *   2. After the publisher adds the record, a second call resolves the TXT and,
 *      on match, sets publishers/{uid}.domainVerified = true, verification = 'verified'.
 *
 * Verified publishers can later be auto-trusted (e.g. skip manual review, unlock
 * higher featured caps). This CF only sets the flag; consumers decide policy.
 */

import admin from 'firebase-admin';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';

const TXT_HOST_PREFIX = '_frontaliereticino';
const TXT_VALUE_PREFIX = 'frontaliereticino-verify=';

function db() {
  return admin.firestore();
}

async function verifyCaller(req) {
  const header = req.get('Authorization') || req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch {
    return null;
  }
}

/** Normalize a domain: strip scheme, path, leading www. */
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

export async function handleVerifyPublisherDomain(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const uid = decoded.uid;

  const pubRef = db().collection('publishers').doc(uid);
  const pubSnap = await pubRef.get();
  if (!pubSnap.exists) return { status: 404, body: { ok: false, error: 'publisher_not_found' } };
  const pub = pubSnap.data();

  const domain = normalizeDomain(pub.company?.domain);
  if (!domain) return { status: 400, body: { ok: false, error: 'no_domain' } };

  // Mint + persist a token on first use (stable across retries).
  let token = pub.domainVerifyToken;
  if (!token) {
    token = randomBytes(16).toString('hex');
    await pubRef.set({ domainVerifyToken: token, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  const recordName = `${TXT_HOST_PREFIX}.${domain}`;
  const recordValue = `${TXT_VALUE_PREFIX}${token}`;

  let verified = false;
  try {
    const records = await dns.resolveTxt(recordName); // string[][]
    const flat = records.map((chunks) => chunks.join('')).map((s) => s.trim());
    verified = flat.includes(recordValue);
  } catch {
    verified = false; // NXDOMAIN / no TXT yet
  }

  if (verified) {
    await pubRef.set(
      { domainVerified: true, verification: 'verified', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  return {
    status: 200,
    body: { ok: true, verified, domain, recordName, recordValue },
  };
}
