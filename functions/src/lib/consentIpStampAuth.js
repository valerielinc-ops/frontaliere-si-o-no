/**
 * consentIpStampAuth — who may ask the server to stamp `consent_ip`, and on
 * whose document (#5920 follow-up to #5676).
 *
 * WHY AN ENDPOINT EXISTS AT ALL
 * -----------------------------
 * `buildConsentIpStamp` (lib/requestForensics.js) argues at length why the
 * address is captured server-side: a browser cannot see its own public IP, and
 * a value it was TOLD is worthless as proof precisely when it matters. Every
 * signup path already crosses a Cloud Function on the way out, so #5676 could
 * stamp there and needed no endpoint.
 *
 * The communications consent banner (#5920) is the first affirmative act that
 * crosses NONE: it writes the proof straight from the browser
 * (`recordCommunicationsConsent`, a Firestore `updateDoc`), so the consent it
 * records is the only one in the register that lands with no network of
 * origin. This module is the gate on the endpoint that closes that gap.
 *
 * WHY THE GATE IS AN ID TOKEN AND NOT A SHARED SECRET
 * ---------------------------------------------------
 * The value being written is EVIDENCE, and `stampConsentIp` never overwrites:
 * the first address recorded against a consent is the one that stands forever.
 * That refusal — right for its own reasons — turns a missing gate into a
 * permanent forgery: an unauthenticated caller could POST somebody else's
 * address and attach ITS OWN network to a stranger's consent, and no later
 * honest call could correct it. So the endpoint requires a Firebase ID token
 * and refuses unless the token's own `email` claim IS the document being
 * stamped. Nobody can stamp anybody but themselves.
 *
 * WHY `email_verified` IS NOT ALSO REQUIRED
 * -----------------------------------------
 * It would exclude most of the exact cohort this serves.
 * `newsletterSubscriberAuthSync.js` creates the shell account of an existing
 * subscriber with `emailVerified: false` (no password, no email sent), and
 * those are the people the banner is shown to. Requiring the claim would leave
 * the field empty for them while looking stricter. What bounds the residual
 * risk instead: this codebase exposes no client-side account CREATION path
 * (`createUserWithEmailAndPassword` appears nowhere under services/ or
 * components/) — accounts are minted server-side — and a subscriber who has a
 * document to stamp already has a shell account, so the address is not free to
 * claim. If a client signup path is ever added, this decision has to be
 * revisited: that is why it is written down here rather than left implicit.
 */

/** Lowercased + trimmed, or '' — the one normalization both sides use. */
export function normalizeConsentEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Decide whether one request may stamp one document. PURE: no Firestore, no
 * `admin.auth()`, no `req` — the caller verifies the token and passes the
 * decoded claims (or null), so every branch below is testable without a
 * network, an emulator or a signed token.
 *
 * The order is deliberate. Authentication is answered BEFORE the body is
 * looked at, so an anonymous caller learns nothing about which addresses are
 * well-formed, let alone which exist.
 *
 * @param {object} input
 * @param {string} [input.method] HTTP verb of the request.
 * @param {{ email?: string }|null} [input.token] Decoded ID token, or null when
 *   absent/invalid — the caller must NOT distinguish the two, see below.
 * @param {unknown} [input.bodyEmail] The address the caller wants stamped.
 * @returns {{ ok: true, email: string }|{ ok: false, status: number, error: string }}
 */
export function decideConsentIpStamp(input) {
  const { method, token, bodyEmail } = input || {};

  if (String(method || '').toUpperCase() !== 'POST') {
    return { ok: false, status: 405, error: 'method_not_allowed' };
  }

  // A malformed header, an expired token and no header at all collapse into
  // ONE answer on purpose: telling them apart tells a prober which tokens the
  // backend still considers live.
  if (!token || typeof token !== 'object') {
    return { ok: false, status: 401, error: 'unauthenticated' };
  }

  const target = normalizeConsentEmail(bodyEmail);
  if (!target || !target.includes('@')) {
    return { ok: false, status: 400, error: 'invalid_email' };
  }

  // Case-insensitive by construction: both sides go through the same
  // normalizer, which is also the one the document id is built with
  // (`newsletter_subscribers/{email}` is stored lowercased).
  const claimed = normalizeConsentEmail(token.email);
  if (!claimed) {
    return { ok: false, status: 403, error: 'no_email_claim' };
  }
  if (claimed !== target) {
    return { ok: false, status: 403, error: 'email_mismatch' };
  }

  return { ok: true, email: target };
}
