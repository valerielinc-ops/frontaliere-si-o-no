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

/** A password-reset request the runner made for this exact portal account. */
export function currentRecoveringPortalAccount(accounts, portalHost) {
  const account = currentPendingPortalAccount(accounts, portalHost);
  return account?.status === 'recovering'
    && typeof account.recoveryRequestedAt === 'number'
    && Number.isFinite(account.recoveryRequestedAt)
    && Boolean(account.recoveryRequestId)
    ? account
    : null;
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
  if (named.length > 0 || waiting.length !== 1) return null;
  // The sole account is bound only when it provably existed before the message
  // (the runner stamps createdAt when it stores the credential).
  const [sole] = waiting;
  // A real number only: Number(null) is 0, which would predate every message.
  const { createdAt } = sole;
  return typeof receivedAt === 'number' && Number.isFinite(receivedAt)
    && typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt <= receivedAt ? sole : null;
}

/**
 * Life-cycle notices that prove the portal holds the account: what the runner
 * may read as an accepted OTP. A changed password proves nothing of the kind.
 */
export const PORTAL_ACCOUNT_NOTICES_CONFIRMING = Object.freeze(['created', 'activated']);

/**
 * The order's portal account (pending or verified, never a discarded one) that
 * a life-cycle notice is about. The notice is only recorded and kept from the
 * candidate, its link is never opened: its sole link on the account's exact
 * host binds it; else, as for a code, the sender's registrable domain, else the
 * order's sole account that provably existed before the message. Two records
 * for one host, or two candidate accounts, bind nothing.
 */
export function portalAccountForNotice(accounts, { link = '', senderHost = '', receivedAt } = {}) {
  const entries = Object.values(accounts || {}).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.host === 'string' && entry.host && entry.status !== 'discarded'
    && (entry.status !== 'recovering' || typeof entry.recoveryRequestedAt === 'number')
    && (typeof entry.recoveryRequestedAt !== 'number' || (Number.isFinite(Number(receivedAt))
      && Number(receivedAt) > entry.recoveryRequestedAt)));
  const byHost = new Map();
  for (const entry of entries) {
    const host = entry.host.toLowerCase();
    byHost.set(host, [...(byHost.get(host) || []), entry]);
  }
  const managed = [...byHost.entries()].filter(([, list]) => list.length === 1).map(([host, [entry]]) => ({ host, entry }));
  if (link) {
    const exact = managed.filter(({ host }) => exactPortalVerificationUrl(link, host));
    if (exact.length === 1) return exact[0].host;
  }
  const sender = String(senderHost || '').toLowerCase();
  if (!sender) return '';
  const named = managed.filter(({ host }) => registrable(host) === registrable(sender));
  if (named.length === 1) return named[0].host;
  if (named.length > 0 || managed.length !== 1) return '';
  const [{ host, entry }] = managed;
  const { createdAt } = entry;
  return typeof receivedAt === 'number' && Number.isFinite(receivedAt)
    && typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt <= receivedAt ? host : '';
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
