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
import { t, htmlLang, normalizeLocale } from './emailI18n.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';
import { bridgeEmailCascadeCredentialsToEnv, getNewsletterTokenPolicyConfig } from './remoteConfigSecrets.js';
import {
  mintNewsletterActionToken,
  resolveNewsletterTokenPolicy,
  TOKEN_SCOPES,
} from './lib/newsletterActionToken.js';
import { dataControllerFooterLine } from './lib/dataControllerIdentity.js';
import {
  confirmationSendRefusal,
  isConfirmationCycleSend,
  confirmationAttemptsUsed,
  lastConfirmationAttemptAt,
  MAX_CONFIRMATION_ATTEMPTS,
} from './lib/confirmationFollowup.js';

const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
const BRAND_BLUE = '#2563EB';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f3f4f6';
const CARD_BG = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const BORDER_COLOR = '#dbe2ea';
const CONFIRMATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function escapeHtml(str) {
 return String(str || '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#039;');
}

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

export function buildNewsletterConfirmationEmailHtml(confirmUrl, locale = 'it') {
 const lang = normalizeLocale(locale);
 const year = new Date().getFullYear();
 return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>${t(lang, 'confirmSubject')}</title>
</head>
<body style="margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
 <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};padding:32px 16px;">
 <tr><td align="center">
 <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
 <tr><td style="text-align:center;padding-bottom:24px;">
 <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}" style="text-decoration:none;">
 <img src="${BASE_URL}/icons/icon-192x192.png" alt="${t(lang, 'brandName')}" width="48" height="48" style="display:block;margin:0 auto 8px;border-radius:12px;" />
 <div style="font-size:22px;font-weight:800;color:${BRAND_BLUE};">${t(lang, 'brandName')}</div>
 <div style="font-size:12px;color:${MUTED_COLOR};letter-spacing:.04em;">${t(lang, 'brandTagline')}</div>
 </a>
 </td></tr>
 <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:32px 28px;">
 <div style="font-size:28px;font-weight:800;color:${BRAND_DARK};padding-bottom:8px;">${t(lang, 'confirmTitle')}</div>
 <div style="font-size:15px;line-height:1.6;color:${TEXT_COLOR};padding-bottom:20px;">
 ${t(lang, 'confirmIntro')}
 </div>
 <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
 <tr><td align="center">
 <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.02em;">
 ${t(lang, 'confirmButton')}
 </a>
 </td></tr>
 </table>
 <div style="font-size:13px;color:${MUTED_COLOR};padding-bottom:10px;">
 ${t(lang, 'confirmAltLink')}
 </div>
 <div style="background:#f8fafc;border:1px solid ${BORDER_COLOR};border-radius:8px;padding:12px;font-size:12px;color:${MUTED_COLOR};word-break:break-all;">
 ${escapeHtml(confirmUrl)}
 </div>
 <div style="border-top:1px solid ${BORDER_COLOR};margin:24px 0;"></div>
 <div style="font-size:14px;color:${TEXT_COLOR};line-height:1.6;">
 ${t(lang, 'confirmWeeklyTitle')}
 <ul style="padding-left:20px;margin:10px 0;">
 <li>${t(lang, 'confirmWeeklyExchange')}</li>
 <li>${t(lang, 'confirmWeeklyJobs')}</li>
 <li>${t(lang, 'confirmWeeklyTax')}</li>
 <li>${t(lang, 'confirmWeeklyGuides')}</li>
 </ul>
 </div>
 <div style="border-top:1px solid ${BORDER_COLOR};margin:24px 0;"></div>
 <div style="font-size:13px;color:${MUTED_COLOR};line-height:1.6;">
 ${t(lang, 'confirmNotYou')}
 </div>
 </td></tr>
 <tr><td style="text-align:center;padding:20px 0 8px;">
 <div style="font-size:12px;color:${MUTED_COLOR};">
 ${t(lang, 'copyright', { year })} ·
 <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}" style="color:${MUTED_COLOR};text-decoration:none;">frontaliereticino.ch</a>
 </div>
 <div style="font-size:11px;color:${MUTED_COLOR};margin-top:6px;">${escapeHtml(dataControllerFooterLine(lang))}</div>
 </td></tr>
 </table>
 </td></tr>
 </table>
</body>
</html>`;
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
 const returnPath = (sourcePath && sourcePath !== '/') ? sourcePath : '';
 // No auth token embedded in the URL — the confirm action's Cloud Function
 // response returns a fresh custom token for auto-login. This avoids the
 // Firebase custom token 1-hour expiry problem entirely.
 const finalUrl = `${BASE_URL}${returnPath}?action=confirm_newsletter&email=${encodeURIComponent(normalizedEmail)}&token=${token}`;

 const { sent, failed } = await sendEmailCascade([{
 payload: {
 from: FROM_EMAIL,
 to: normalizedEmail,
 subject: t(emailLocale, 'confirmSubject'),
 html: buildNewsletterConfirmationEmailHtml(finalUrl, emailLocale),
 tags: [
 { name: 'campaign_id', value: 'confirmation' },
 { name: 'type', value: 'transactional' },
 { name: 'locale', value: emailLocale },
 ],
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
 // consume one of the three.
 const isCycleSend = isConfirmationCycleSend({ data, purpose });
 const attemptsBefore = confirmationAttemptsUsed(data);
 const subscriberUpdate = {
 confirmation_sent_at: admin.firestore.FieldValue.serverTimestamp(),
 confirmation_message_id: messageId,
 preferred_locale: emailLocale,
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 };
 if (isCycleSend) {
 subscriberUpdate.confirmation_attempts = attemptsBefore + 1;
 if (attemptsBefore === 0) {
 subscriberUpdate.confirmation_first_sent_at = admin.firestore.FieldValue.serverTimestamp();
 }
 }
 await subscriberRef.update(subscriberUpdate);

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'confirmation_email_sent',
 source_channel: 'newsletter_confirmation',
 message_id: messageId,
 locale: emailLocale,
 // The per-attempt evidence, in the subcollection that survives the next
 // overwrite of the flat fields. `null` when the send was not part of a
 // cycle, so a login link is never counted as an ask afterwards.
 confirmation_attempt: isCycleSend ? attemptsBefore + 1 : null,
 confirmation_attempts_max: MAX_CONFIRMATION_ATTEMPTS,
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return { success: true, messageId };
}
