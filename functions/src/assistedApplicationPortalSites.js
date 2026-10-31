/**
 * Which site a portal's verification link belongs to. Shared by the portal
 * runner (scripts/assisted-application/lib/portal/account.mjs opens a link
 * only on the portal's own site) and the inbound handler (a verification
 * message is kept from the candidate only when an account of the order on that
 * site is waiting for it).
 */

// Families whose verification mail links to a sibling domain of the career site.
const SITE_FAMILIES = [
  ['myworkdayjobs.com', 'myworkday.com', 'workday.com'],
  ['successfactors.eu', 'successfactors.com', 'sapsf.eu', 'sapsf.com'],
];

function registrable(host) {
  return String(host || '').toLowerCase().split('.').slice(-2).join('.');
}

// A verification token belongs to the exact account host. Shared ATS families
// and public suffixes do not establish that two accounts have the same owner.
export const MAX_PORTAL_VERIFICATION_URL = 2000;

export function exactPortalVerificationUrl(value, portalHost) {
  if (typeof value !== 'string' || !value || value.length > MAX_PORTAL_VERIFICATION_URL
    || !/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return '';
  const host = String(portalHost || '').toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) return '';
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && !target.username && !target.password && !target.port
      && target.hostname === host ? value : '';
  } catch {
    return '';
  }
}

/** A verification link on the portal's own site (or its ATS family), over https. */
export function sameSite(url, portalHost) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:') return false;
  const a = registrable(target.hostname);
  const b = registrable(portalHost);
  if (!a || !b) return false;
  if (a === b) return true;
  return SITE_FAMILIES.some((family) => family.includes(a) && family.includes(b));
}
