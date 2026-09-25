/**
 * newsletterRecordConsentAuth — who may deposit a proof of consent on a
 * newsletter document, and what may be written when they do (#5928, phase 1;
 * reabsorbs and hardens the gate of #5927).
 *
 * WHAT THIS ENDPOINT REPLACES, AND WHY IT HAD TO
 * ----------------------------------------------
 * The consent banner (#5842/#5920) records its proof with a browser
 * `updateDoc` straight onto `newsletter_subscribers/{email}`, and
 * `firestore.rules` still carries `allow write: if true` on that collection.
 * So the `consent_text` — the one field the art. 25 register exists to
 * establish — is fabricable by anyone who knows the project id. #5927 closed
 * the missing-IP half but left the write itself in the browser, behind a gate
 * (`decideConsentIpStamp`) that accepted ANY token whose `email` claim matched
 * the target, `email_verified` or not. That is not proof of possession: two
 * server paths mint a token with an arbitrary, unverified `email` claim.
 *
 * WHY THE GATE REQUIRES `email_verified === true`
 * -----------------------------------------------
 * Owner ruling 2026-08-15 (ratified): the ONLY proof of possession accepted in
 * this phase is `email_verified === true`. No nonce, no new server state. That
 * single predicate is exactly what excludes the two forgeable minting paths,
 * and the reason is worth writing down because both are silent:
 *
 *   - `newsletterSubscriberAuthSync.js` creates the shell Auth account of an
 *     existing subscriber with `emailVerified: false` (no password, no email
 *     sent). A claim-only gate would let that shell — or anyone who can drive
 *     the same sync — stamp a consent on any address it names.
 *   - `stripeReaderCore.js` resolves the user on the Stripe GUEST email, which
 *     is free text and never verified (the file says so verbatim). Its minted
 *     token also carries `email_verified: false`.
 *
 * Requiring `email_verified` refuses BOTH by construction: neither path can
 * produce the one claim Firebase only sets after a real possession check
 * (a verification email clicked, or a social IdP that already verified it).
 *
 * WHAT THIS COSTS, AND WHO PAYS IT
 * --------------------------------
 * The banner's own majority cohort — the `ac`-redeemed shell accounts it is
 * shown to — is `email_verified: false`, so this gate refuses them and their
 * proof is NOT written here. That is intended: the banner falls back to the
 * existing client-side `recordCommunicationsConsent` for them (same behaviour
 * as today, minus the server IP), because trusting their claim is exactly the
 * forgery this gate exists to stop. The verified cohort (social sign-in, and
 * anyone Firebase actually verified) gets the full server-written proof + IP.
 *
 * EVERYTHING BELOW IS PURE: no Firestore, no `admin.auth()`, no `req`. The
 * caller verifies the token and hands the decoded claims in, so every branch
 * is testable without an emulator or a signed token.
 */

import { isNewsletterOptOutBinding } from './newsletterOptOut.js';

/** Lowercased + trimmed, or '' — the one normalization both sides use, and the
 *  one the document id is built with (`newsletter_subscribers/{email}`). */
export function normalizeConsentEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The two spellings of the stored consent text — a document carrying EITHER
 * already has a proof and must not be overwritten. Mirrors
 * `CONSENT_TEXT_FIELDS` in services/jobAlertConsentUpgrade.ts; the parity is
 * pinned by the endpoint test, never assumed.
 */
export const CONSENT_TEXT_FIELDS = Object.freeze(['consent_text', 'consentText']);

/**
 * The EXACT set of fields this endpoint will ever write onto a subscriber
 * document. It is an allowlist, not a denylist: `status`, `active`,
 * `consent_given` and `consent_method` are absent because they are FORBIDDEN
 * here (the register's rule — only a real checkbox asserts `consent_given`,
 * and `consent_method` is the immutable provenance of the original signup),
 * and an allowlist makes a client that sends them a no-op rather than a
 * fabrication. The server-owned members (ip / user_agent / upgraded_at) are
 * set by the handler from what it observes, never from the body.
 */
export const RECORD_CONSENT_ALLOWED_FIELDS = Object.freeze([
  'consent_text',
  'consent_text_version',
  'consent_text_displayed',
  'consent_page_version',
  'consent_act',
  'consent_origin',
]);

/** Fields no consent write from this surface may ever carry — asserted, so a
 *  future edit that widens the allowlist into one of them fails loudly. */
export const RECORD_CONSENT_FORBIDDEN_FIELDS = Object.freeze([
  'status',
  'active',
  'consent_given',
  'consent_given_at',
  'consent_method',
]);

/**
 * Decide whether one request may deposit a consent proof on one document.
 *
 * The order is deliberate and part of the contract:
 *   1. method  — POST only (405)
 *   2. auth    — a token must be present (401). A missing header, an expired
 *                token and a malformed one collapse into ONE answer: the caller
 *                verifies and passes `null` for all three, so a prober cannot
 *                tell which tokens the backend still considers live.
 *   3. verified — `email_verified === true`, strictly (403 `email_not_verified`).
 *                This is answered BEFORE the body's address, so an
 *                unverified caller learns nothing about which addresses exist.
 *   4. address — the target must look like an email (400).
 *   5. claim   — the token's own `email` must BE the target (403). A token with
 *                no email claim is a refusal, never a wildcard.
 *
 * @param {object} input
 * @param {string} [input.method]
 * @param {{ email?: string, email_verified?: boolean }|null} [input.token] Decoded
 *   ID token, or null when absent/invalid.
 * @param {unknown} [input.bodyEmail]
 * @returns {{ ok: true, email: string }|{ ok: false, status: number, error: string }}
 */
export function decideRecordConsent(input) {
  const { method, token, bodyEmail } = input || {};

  if (String(method || '').toUpperCase() !== 'POST') {
    return { ok: false, status: 405, error: 'method_not_allowed' };
  }

  if (!token || typeof token !== 'object') {
    return { ok: false, status: 401, error: 'unauthenticated' };
  }

  // PROOF OF POSSESSION, and the whole point of this module: strictly `=== true`.
  // A truthy-but-not-true value (a string 'true', 1) is NOT the boolean claim
  // Firebase sets, and treating it as such would re-open the exact gap the
  // shell/Stripe token paths drive through.
  if (token.email_verified !== true) {
    return { ok: false, status: 403, error: 'email_not_verified' };
  }

  const target = normalizeConsentEmail(bodyEmail);
  if (!target || !target.includes('@')) {
    return { ok: false, status: 400, error: 'invalid_email' };
  }

  const claimed = normalizeConsentEmail(token.email);
  if (!claimed) {
    return { ok: false, status: 403, error: 'no_email_claim' };
  }
  if (claimed !== target) {
    return { ok: false, status: 403, error: 'email_mismatch' };
  }

  return { ok: true, email: target };
}

/**
 * Why a gate-passed write still did not happen. Named so the caller can report
 * it and a test can count them. Mirrors `NewsletterConsentSkipReason` in
 * services/newsletterConsentUpgrade.ts.
 * @typedef {'no-document'|'opt-out-binding'|'already-has-proof'} RecordConsentSkipReason
 */

/**
 * May this subscriber document be stamped? PURE mirror of
 * `planNewsletterConsentUpgrade` (services/newsletterConsentUpgrade.ts), and
 * THE ORDER IS THE CONTRACT — the same order, for the same reasons:
 *
 *   - no document      → nothing to attribute a consent to; NEVER create one
 *     (a merge write on a missing id would manufacture a subscriber out of a
 *     banner click);
 *   - opt-out binding  → a person who left must not be re-engaged; this
 *     outranks every other answer (#5672's 186 "resuscitati");
 *   - already has proof → NEVER overwrite; losing the date of the first
 *     consent is worse than failing to refresh it.
 *
 * @param {Record<string, unknown>|null|undefined} existing The document data,
 *   or null/undefined when it does not exist. NOT a Firestore handle — the
 *   caller passes `snap.exists ? snap.data() : null`.
 * @returns {{ write: true }|{ write: false, reason: RecordConsentSkipReason }}
 */
export function planNewsletterConsentWrite(existing) {
  if (!existing || typeof existing !== 'object') {
    return { write: false, reason: 'no-document' };
  }
  if (isNewsletterOptOutBinding(existing)) {
    return { write: false, reason: 'opt-out-binding' };
  }
  for (const field of CONSENT_TEXT_FIELDS) {
    const v = existing[field];
    if (v != null && v !== '') return { write: false, reason: 'already-has-proof' };
  }
  return { write: true };
}

/**
 * Pick ONLY the allowlisted proof fields out of a caller-supplied object,
 * coercing each to a safe type. This is the second half of the anti-forgery
 * argument: the gate proves WHO is writing, this bounds WHAT they can write.
 * A `status`, an `active` or a `consent_given` in the body is silently dropped
 * because it is not a key here — the write can never assert them.
 *
 * `consent_act` and `consent_origin` are additionally pinned to the banner's
 * own constants: this endpoint records exactly one act, so a body naming a
 * different one (e.g. `job_alert_activation_click`, which did not happen) is
 * refused rather than stored.
 *
 * @param {unknown} proof
 * @param {{ expectedAct: string, expectedOrigin: string }} pins
 * @returns {{ ok: true, fields: Record<string, string|boolean> }|{ ok: false, error: string }}
 */
export function pickConsentProofFields(proof, pins) {
  if (!proof || typeof proof !== 'object') {
    return { ok: false, error: 'invalid_proof' };
  }
  const src = /** @type {Record<string, unknown>} */ (proof);
  const out = {};

  const text = src.consent_text;
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'invalid_proof' };
  }
  out.consent_text = text;

  if (typeof src.consent_text_version === 'string' && src.consent_text_version.trim()) {
    out.consent_text_version = src.consent_text_version;
  }
  if (typeof src.consent_text_displayed === 'boolean') {
    out.consent_text_displayed = src.consent_text_displayed;
  }
  if (typeof src.consent_page_version === 'string' && src.consent_page_version.trim()) {
    out.consent_page_version = src.consent_page_version;
  }

  // Act and origin are the surface's identity: pinned, not accepted.
  if (src.consent_act !== pins.expectedAct) {
    return { ok: false, error: 'unexpected_act' };
  }
  out.consent_act = pins.expectedAct;
  if (src.consent_origin !== pins.expectedOrigin) {
    return { ok: false, error: 'unexpected_origin' };
  }
  out.consent_origin = pins.expectedOrigin;

  return { ok: true, fields: out };
}
