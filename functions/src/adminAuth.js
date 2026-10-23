import { getAuth } from 'firebase-admin/auth';

export const SITE_ADMIN_UIDS = Object.freeze([
  'aAqGpXr2mUQNQlio3gCxut4bBzH3',
]);

export const SITE_ADMIN_EMAILS = Object.freeze([
  'valerielinc@gmail.com',
]);

const siteAdminUids = new Set(SITE_ADMIN_UIDS);
const siteAdminEmails = new Set(SITE_ADMIN_EMAILS.map((email) => email.toLowerCase()));

function getBearerToken(req) {
  const header = typeof req?.get === 'function'
    ? req.get('Authorization')
    : req?.headers?.authorization || req?.headers?.Authorization;
  if (!header || !/^Bearer\s+\S+$/i.test(header)) return null;
  return header.replace(/^Bearer\s+/i, '').trim();
}

export async function assertSiteAdmin(req) {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'missing_id_token' };
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (error) {
    console.warn('Admin authentication rejected: invalid Firebase ID token', error?.message || error);
    return { ok: false, status: 401, error: 'invalid_id_token' };
  }

  const email = String(decoded?.email || '').trim().toLowerCase();
  const emailVerified = decoded?.email_verified === true;
  if (!emailVerified || !siteAdminEmails.has(email) || !siteAdminUids.has(decoded?.uid)) {
    return { ok: false, status: 403, error: 'not_admin' };
  }

  return { ok: true, uid: decoded.uid, email };
}
