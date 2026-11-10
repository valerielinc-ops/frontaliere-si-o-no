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

/**
 * The one pending account that can be bound to an exact portal host. Account
 * document keys are schema history, not identity: a canonical key and a
 * legacy alias with the same host are an ambiguity, never a reason to pick a
 * first or newest record.
 */
export function currentPendingPortalAccount(accounts, portalHost) {
  const normalizedHost = String(portalHost || '').toLowerCase();
  if (!normalizedHost) return null;
  const matches = Object.values(accounts || {}).filter((entry) => entry && typeof entry === 'object'
    && !Array.isArray(entry)
    && String(entry.host || '').toLowerCase() === normalizedHost);
  if (matches.length !== 1) return null;
  const [entry] = matches;
  const encryptedPassword = entry.passwordEnc;
  return encryptedPassword && typeof encryptedPassword === 'object' && !Array.isArray(encryptedPassword)
    && entry.verifiedAt == null ? entry : null;
}

/**
 * The order's accounts still waiting for their verification, one per host (a
 * host with an ambiguous record set is left out, as currentPendingPortalAccount does).
 */
export function pendingPortalAccounts(accounts) {
  const hosts = new Set(Object.values(accounts || {})
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => String(entry.host || '').toLowerCase())
    .filter(Boolean));
  return [...hosts].map((host) => currentPendingPortalAccount(accounts, host)).filter(Boolean);
}

/**
 * The code of a portal's account verification may come from the employer's own
 * domain instead of the ATS host (a SuccessFactors tenant on career74.sapsf.eu
 * mails from job@stelle.admin.ch). A code only fills the one-time-code page the
 * runner itself opened, so it is bound to the waiting account whose registrable
 * domain is the sender's, else to the order's sole waiting account created before
 * the message. A link never takes this path: it is opened, so it needs its exact host.
 */
export function pendingAccountForCode(accounts, senderHost, { receivedAt } = {}) {
  const sender = String(senderHost || '').toLowerCase();
  if (!sender) return null;
  const at = Number(receivedAt);
  const waiting = pendingPortalAccounts(accounts)
    .filter((entry) => !(Number.isFinite(at) && Number(entry.createdAt) > at));
  const named = waiting.filter((entry) => registrable(entry.host) === registrable(sender));
  if (named.length === 1) return named[0];
  return named.length === 0 && waiting.length === 1 ? waiting[0] : null;
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
