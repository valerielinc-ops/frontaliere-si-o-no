/**
 * newsletterConfirmationEmail.js — Newsletter double opt-in confirmation email
 *
 * Sends a branded confirmation email to new newsletter subscribers via Resend.
 * Uses HMAC tokens for secure confirmation link verification.
 * Includes 1-hour cooldown to prevent spam.
 *
 * Suppression: transactional, so guarded only against a hard bounce or a filed
 * spam complaint (isTransactionalHardBlock, lib/emailSuppression.js). `pending`
 * is the normal state for this email and must never be blocked.
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { isTransactionalHardBlock } from './lib/emailSuppression.js';
import { normalizeLocale } from './emailI18n.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';
import { bridgeEmailCascadeCredentialsToEnv, getNewsletterTokenPolicyConfig } from './remoteConfigSecrets.js';
import {
  mintNewsletterActionToken,
  resolveNewsletterTokenPolicy,
  TOKEN_SCOPES,
} from './lib/newsletterActionToken.js';
import {
  CONFIRMATION_FRAMES,
  CONFIRMATION_FROM_EMAIL,
  buildConfirmationRequestEmail,
  confirmationConfirmUrl,
  confirmationFrameForAttempt,
} from './lib/confirmationEmailContent.js';
import {
  confirmationSendRefusal,
  isConfirmationCycleSend,
  confirmationAttemptsUsed,
  confirmationFirstSentAt,
  lastConfirmationAttemptAt,
  buildConfirmationSentFields,
  buildConfirmationSentEvent,
} from './lib/confirmationFollowup.js';

// The template, the sender address and the confirm URL now live in
// lib/confirmationEmailContent.js: scripts/newsletter-confirmation-followups.mjs
// composes requests #2 and #3 from the same module, and a Cloud Functions file
// is not importable from a script. Re-exported so every existing importer of
// this module — tests included — keeps working unchanged.
export { buildNewsletterConfirmationEmailHtml } from './lib/confirmationEmailContent.js';

const CONFIRMATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * The confirmation link's credential — scoped to `confirm` and dated (#5704).
 *
 * It used to be `HMAC(secret, email)`: the same string the unsubscribe link, the
 * re-subscribe link and the whole preferences API accepted, and it never
 * expired. A June confirmation email was still a working re-subscribe button in
 * August — one of the three resurrection paths #5704 was opened for — and the
 * email's own "the link is valid for 7 days", in four languages, had nothing
 * behind it. The token now names its action and carries its issue date, and
 * handleSubscriptionManagement refuses it past that window.
 *
 * @param {string} email
 * @param {string} secret
 * @param {{policy?: object, scheme?: 'legacy'|'v1', now?: number}} [opts] `policy`
 *   MUST be threaded by Cloud Functions callers: NEWSLETTER_TOKEN_* is not in
 *   process.env there, so an omitted policy means the built-in defaults and a
 *   Remote Config rollback would never reach this minter.
 * @returns {string|null} null when there is no secret
 */
export function generateConfirmationToken(email, secret, { policy, scheme, now } = {}) {
  return mintNewsletterActionToken(email, TOKEN_SCOPES.CONFIRM, {
    secret,
    policy,
    scheme,
    ...(now === undefined ? {} : { now }),
  });
}

export async function sendNewsletterConfirmationEmail({ email, locale, sourcePath, secret, db: injectedDb, purpose }) {
 // purpose 'login' → send the confirm link even to an already-confirmed
 // subscriber (used as a passwordless sign-in link; the confirm action is a
 // no-op for them but still mints a custom token for auto-login). The cooldown
 // guard below still applies to prevent abuse.
 const isLoginLink = purpose === 'login';
 if (!email || !email.includes('@')) {
 return { success: false, error: 'invalid_email' };
 }
 // Cascade-routed (2026-07-16, was a direct Resend client) — pacing +
 // fallback if Resend alone is exhausted. Cloud Functions source secrets
 // async via Remote Config; the cascade reads sync process.env.*, so the
 // bridge must run first. Error string kept as-is (no external consumer
 // depends on it meaning "Resend specifically" vs. "no provider at all").
 await bridgeEmailCascadeCredentialsToEnv();
 if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
 return { success: false, error: 'missing_resend_api_key' };
 }
 if (!secret) {
 return { success: false, error: 'missing_newsletter_secret' };
 }

 const normalizedEmail = email.toLowerCase().trim();
 const db = injectedDb || getAdminDb();
 const lang = normalizeLocale(locale);

 const subscriberRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
 const subscriberDoc = await subscriberRef.get();

 if (!subscriberDoc.exists) {
 return { success: false, error: 'subscriber_not_found' };
 }

 const data = subscriberDoc.data();

 // NARROW hard-block guard: only a provably dead mailbox (hard bounce) or a
 // filed spam complaint. A double-opt-in confirmation is transactional — the
 // user asked for it seconds ago — so `unsubscribed` / `inactive` / `pending` /
 // soft-bounced addresses still get their email; `pending` in particular IS the
 // normal state here, and blocking it would break signup outright. Rationale +
 // exact set: isTransactionalHardBlock in lib/emailSuppression.js. No extra
 // Firestore read: this reads fields off the doc already fetched above, so the
 // guard adds no new failure path of its own.
 if (isTransactionalHardBlock({ status: data?.status, bounceSeverity: data?.bounce_severity })) {
 console.warn(`[newsletterConfirmation] suppressed address, send skipped: status=${data?.status}`);
 return { success: false, error: 'address_suppressed' };
 }

 if (data.status === 'confirmed' && data.isActive && !isLoginLink) {
 return { success: false, error: 'already_confirmed' };
 }

 const now = Date.now();

 // THE CAP LIVES HERE (#5692), at the send point, and not in whoever calls it.
 // Three requests, the first one included; a cap enforced by the caller is a
 // cap the next caller does not have, and the callers of this function are
 // already three (the SPA signup write, the "resend" button, and the follow-up
 // runner scripts/newsletter-confirmation-followups.mjs) with a scheduled
 // fourth to come. `confirmationSendRefusal` also holds a request that
 // declares itself part of the follow-up cadence to the one-per-day floor.
 //
 // It exempts what is not a double opt-in at all: a `purpose: 'login'` link,
 // and any address that already carries the confirmation stamp — the 848
 // `pending` re-probes measured on 2026-08-13. See lib/confirmationFollowup.js.
 const refusal = confirmationSendRefusal({ data, purpose, now });
 if (refusal) {
 console.warn(`[newsletterConfirmation] ${refusal.error} after ${refusal.attempts} attempt(s), send skipped`);
 return { success: false, error: refusal.error };
 }

 // The 1-hour cooldown, unchanged in what it protects: a double click on
 // "resend" within the minute. It is NOT the follow-up rule and must not be
 // mistaken for one — a reminder is due 20+ hours after the previous request,
 // so this window can never be what blocks one. Both spellings of the stamp
 // are read now (the previous code read only `confirmation_sent_at`, so a
 // camelCase-only document had no cooldown at all).
 const lastAttemptMs = lastConfirmationAttemptAt(data);
 if (lastAttemptMs != null && now - lastAttemptMs < CONFIRMATION_COOLDOWN_MS) {
 return { success: false, error: 'cooldown_active' };
 }

 // Always use the locale the caller sent (= the language the user is browsing in).
 // Only fall back to subscriber's stored locale if no locale was provided.
 const emailLocale = lang || normalizeLocale(data.preferred_locale || data.signup_locale || 'it');

 // Read the token policy from Remote Config, exactly like the welcome email
 // reads the `ac` policy (#5726): NEWSLETTER_TOKEN_* is not in this runtime's
 // process.env, so without this read the minter always sees the built-in
 // defaults — and the Remote Config ROLLBACK (`NEWSLETTER_TOKEN_SCHEME=legacy`,
 // `NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS=0`) would silently never reach the one
 // scope that is v1-by-default. Same 5-minute template cache as the secret read
 // above, so it costs no round-trip in the warm path; a failure falls back to
 // the defaults rather than blocking a transactional email.
 let tokenPolicy;
 try {
   tokenPolicy = resolveNewsletterTokenPolicy(await getNewsletterTokenPolicyConfig());
 } catch (policyErr) {
   console.warn('[newsletterConfirmation] token policy read failed, using defaults:', policyErr?.message || policyErr);
   tokenPolicy = resolveNewsletterTokenPolicy({});
 }
 const token = generateConfirmationToken(normalizedEmail, secret, { policy: tokenPolicy });
 // No auth token embedded in the URL — the confirm action's Cloud Function
 // response returns a fresh custom token for auto-login. This avoids the
 // Firebase custom token 1-hour expiry problem entirely.
 const finalUrl = confirmationConfirmUrl({ email: normalizedEmail, token, sourcePath });

 // Which of the three this is, decided from the SAME counter the cap reads and
 // the write below increments (#5692). This function normally sends request #1,
 // but it is also the send point the follow-up runner reaches through, and the
 // "resend" button can land on a document that already has one or two behind
 // it — so the frame is derived, never assumed. A login link and an
 // already-confirmed re-probe are not in a cycle at all, and get the plain
 // email: telling somebody "this is the last reminder" when they have confirmed
 // and are simply signing in would be false, and alarming.
 const isCycleSend = isConfirmationCycleSend({ data, purpose });
 const attemptsBefore = confirmationAttemptsUsed(data);
 const frame = isCycleSend ? confirmationFrameForAttempt(attemptsBefore + 1) : CONFIRMATION_FRAMES.FIRST;
 const { subject, html, tags } = buildConfirmationRequestEmail({
 locale: emailLocale,
 confirmUrl: finalUrl,
 frame,
 firstSentAt: confirmationFirstSentAt(data),
 });

 const { sent, failed } = await sendEmailCascade([{
 payload: {
 from: CONFIRMATION_FROM_EMAIL,
 to: normalizedEmail,
 subject,
 html,
 tags,
 },
 recipient: { email: normalizedEmail },
 meta: {},
 }]);

 if (failed.length > 0) {
 console.error('[newsletterConfirmation] send error:', failed[0].error);
 return { success: false, error: 'email_send_failed' };
 }
 const messageId = sent[0]?.messageId || null;

 // THE LEDGER (#5692). Until now the only trace a request left was
 // `confirmation_sent_at`, which is overwritten by the next one — so nothing
 // could tell "asked once" from "asked three times", and the tetto the owner
 // asked for was not verifiable from the document. The counter is incremented
 // exactly where the mail actually leaves, so it counts sends and not
 // intentions, and `confirmation_first_sent_at` anchors the window: together
 // they are the record of having asked three times and stopped.
 //
 // Only for a real cycle send: a passwordless login link and a re-probe of an
 // already-confirmed address are not double opt-in requests and must not
 // consume one of the three. `isCycleSend`/`attemptsBefore` are read ABOVE, from
 // the same values that chose the frame, so the email and the ledger can never
 // describe different attempts.
 //
 // Both writes come from lib/confirmationFollowup.js because the follow-up
 // runner performs them too, for requests #2 and #3. A second copy of the
 // increment here is how one of the two senders would eventually stop counting.
 await subscriberRef.update(
 buildConfirmationSentFields({
 attemptsBefore,
 isCycleSend,
 messageId,
 locale: emailLocale,
 stamp: admin.firestore.FieldValue.serverTimestamp(),
 }),
 );

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add(
 buildConfirmationSentEvent({
 email: normalizedEmail,
 attemptsBefore,
 isCycleSend,
 messageId,
 locale: emailLocale,
 occurredAt: new Date().toISOString(),
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 }),
 );

 return { success: true, messageId };
}
