/**
 * newsletterSubscriptionManagement.js — HMAC-verified unsubscribe/resubscribe handler
 *
 * Provides a Cloud Function endpoint that:
 * 1. Verifies HMAC tokens for unsubscribe/resubscribe URLs
 * 2. Updates subscriber status in Firestore
 * 3. Returns a branded HTML confirmation page
 *
 * URLs are generated in send-newsletter.mjs with the NEWSLETTER_SECRET env var.
 *
 * Every write that sets `unsubscribed_at` here also records forensics
 * (`unsubscribe_method` / `_user_agent` / `_ip`), built by the caller via
 * `lib/requestForensics.js` and threaded in as an option so this handler stays
 * pure. Attribution only — nothing reads them back, so a GET still unsubscribes
 * immediately and the RFC 8058 one-click POST is unchanged.
 *
 * THE ASYMMETRY (#5711): OPT-OUT IS ONE-CLICK, OPT-IN IS NOT
 * ----------------------------------------------------------
 * RFC 8058 requires the unsubscribe to happen on a single unattended request,
 * and it still does. The INVERSE action does not get that treatment, because
 * the population that presses an unattended link is not the population that
 * meant to. Measured in production on 2026-08-12, with #5672 already merged:
 * one address unsubscribed at 12:40:53 and was back at `confirmed`/active at
 * 12:40:55 with `source_channel: resubscribe_link` — 1,5 seconds, the same
 * signature as the antiphishing scanner of #5674 (25 fetches in 7 seconds from
 * a Microsoft range). The re-subscribe was a `GET` on a link rendered onto the
 * unsubscribe confirmation page, i.e. the one door #5672 left open, and a
 * crawler walks through it exactly as it walks through every other link.
 *
 * So `action=resubscribe` now needs a `POST`. A `GET` renders the confirmation
 * form and WRITES NOTHING AT ALL — not even an event, so a scanner sweeping the
 * page cannot amplify itself into the database. The exception in
 * `isExplicitNewsletterReOptIn` (services/newsletterSubscribers.ts) is
 * untouched: a human who changes their mind still gets back in, in two clicks
 * instead of one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import admin from 'firebase-admin';
import { ensureAdminApp, getAdminDb } from './newsletterResendWebhookCore.js';
import { t, htmlLang, normalizeLocale } from './emailI18n.js';
import { forensicsFields } from './lib/requestForensics.js';
import { isNewsletterOptOutBinding, toEpochMillis } from './lib/newsletterOptOut.js';
import { verifyAutologinCode, resolveAutologinPolicy, revokedBeforeMs } from './lib/autologinCode.js';

const BASE_URL = 'https://frontaliereticino.ch';
// Proxied by the CF Worker straight to this function (see UNSUB_PROXIES in
// infra/cloudflare-worker/locale-router.js) — bypasses the SPA/index.html
// catch-all so the confirmation page's own resubscribe link doesn't loop
// back into the `ac`-autologin dead end (App.tsx rejects a plain token link).
const ONE_CLICK_BASE_URL = `${BASE_URL}/disiscrivi-newsletter/`;
const BRAND_BLUE = '#2563EB';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f3f4f6';
const CARD_BG = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const BORDER_COLOR = '#dbe2ea';

function normalizeEmail(value) {
 return String(value || '').trim().toLowerCase();
}

export function verifyHmacToken(email, token, secret) {
 if (!secret || !email || !token) return false;
 const expected = createHmac('sha256', secret)
 .update(normalizeEmail(email))
 .digest('hex');
 try {
 return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
 } catch {
 return false;
 }
}

function escapeHtmlAttr(value) {
 return String(value == null ? '' : value)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#39;');
}

/**
 * Is this credential good enough to record an OPT-OUT? (#5685)
 *
 * Two shapes are accepted, and only for leaving:
 *  - the plain email HMAC (`token`), which is what the RFC 8058 one-click link
 *    and every /disiscrivi-newsletter/ URL carry;
 *  - an AUTHENTIC autologin code (`ac`) of ANY age and ANY revocation state,
 *    including one belonging to a subscriber with `autologin_enabled:false`.
 *
 * The second is the separation of powers. Once `ac` can expire, the footer
 * unsubscribe link of every email already sitting in every inbox would stop
 * working at the moment of expiry — the SPA rejects a bare email+token link, so
 * `ac` is the only credential most of those links have. Expiring the exit is
 * the one outcome this wave must not produce: it exists because of an LPD art.
 * 25/32 complaint about an unsubscribe link that did not work.
 *
 * Accepting a stale code here costs nothing. The only thing its holder can do
 * is remove that address from our lists — which the eternal one-click token has
 * always allowed anyone holding the link to do. Refusing is the actual harm.
 *
 * NOT symmetric: `resubscribe` never takes this path. An authentic-but-stale
 * code must not be able to put somebody back on a list (that is the #5672
 * resurrection loop). Opt-out only, forever; opt-in only with a live session.
 *
 * @returns {{ok: boolean, viaEmailToken: boolean, viaAutologin: boolean}}
 */
export function verifyOptOutCredential(email, token, secret) {
 const viaEmailToken = verifyHmacToken(email, token, secret);
 if (viaEmailToken) return { ok: true, viaEmailToken: true, viaAutologin: false };
 // No policy argument, deliberately: nothing configurable may reach this
 // decision. verifyAutologinCode's `canOptOut` is `authentic` and nothing else.
 const verdict = verifyAutologinCode(email, token, { secret });
 return { ok: verdict.canOptOut, viaEmailToken: false, viaAutologin: verdict.canOptOut };
}

/**
 * The re-subscribe control, and it is a FORM, never an `<a href>` (#5711).
 *
 * A link is something a crawler follows; a form is something a person submits.
 * That is the entire mechanism — no bot detection, no UA allowlist, nothing that
 * has to be kept up to date against whoever is scanning this month. The
 * mail-security scanners that produced the 1,5-second reactivation issue
 * requests, they do not fill in and post forms.
 *
 * `method="POST"` and no `formaction`/`target` games: the browser sends the
 * hidden fields as a body, the Worker
 * (infra/cloudflare-worker/locale-router.js) forwards method+body verbatim via
 * `new Request(upstream, request)`, and functions/index.js merges body over
 * query — so the same handler sees the same params it always did.
 */
function buildResponseHtml({ title, message, showResubscribe, email, token, locale }) {
 const lang = normalizeLocale(locale);
 const resubscribeBlock = showResubscribe
 ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
 <tr><td align="center">
 <form method="POST" action="${ONE_CLICK_BASE_URL}" style="margin:0;">
 <input type="hidden" name="action" value="resubscribe">
 <input type="hidden" name="email" value="${escapeHtmlAttr(email)}">
 <input type="hidden" name="token" value="${escapeHtmlAttr(token)}">
 <input type="hidden" name="lang" value="${escapeHtmlAttr(lang)}">
 <button type="submit" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;border:0;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;">
 ${t(lang, 'manageResubscribeLink')}
 </button>
 </form>
 </td></tr>
 </table>`
 : '';

 return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>${title} – ${t(lang, 'brandName')}</title>
 <style>body { margin:0; padding:0; background:${LIGHT_BG}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }</style>
</head>
<body>
 <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};padding:48px 16px;">
 <tr><td align="center">
 <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
 <tr><td style="text-align:center;padding-bottom:24px;">
 <a href="${BASE_URL}" style="text-decoration:none;">
 <div style="font-size:22px;font-weight:800;color:${BRAND_BLUE};">${t(lang, 'brandName')}</div>
 <div style="font-size:12px;color:${MUTED_COLOR};letter-spacing:.04em;">${t(lang, 'brandTagline')}</div>
 </a>
 </td></tr>
 <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:32px 28px;text-align:center;">
 <div style="font-size:24px;font-weight:800;color:${BRAND_DARK};padding-bottom:12px;">${title}</div>
 <div style="font-size:15px;line-height:1.6;color:${TEXT_COLOR};">${message}</div>
 ${resubscribeBlock}
 </td></tr>
 <tr><td style="text-align:center;padding:20px 0;">
 <a href="${BASE_URL}" style="font-size:14px;color:${BRAND_BLUE};text-decoration:none;font-weight:600;">${t(lang, 'manageBackToSite')} →</a>
 </td></tr>
 </table>
 </td></tr>
 </table>
</body>
</html>`;
}

const MAX_ALERTS_PER_USER = 10;
// Company-pinned alerts get their own budget — see MAX_COMPANY_ALERTS_PER_USER
// in services/jobAlertService.ts for the reasoning. Mirrored here because the
// functions bundle cannot import outside `functions/`; parity is pinned by
// tests/company-alert.test.ts.
//
// Raised 10 → 20 with the per-recipient grouping in
// scripts/send-company-alerts.mjs (residuo #5283): the old 10 was standing in
// for grouping that did not exist, not for a real limit on how many employers
// someone may follow. It is pinned to COMPANY_ALERT_MAX_TOTAL_CARDS so a
// recipient's entire follow set always fits in one email.
const MAX_COMPANY_ALERTS_PER_USER = 20;
const ALERT_LIST_FIELDS = ['keywords', 'locations', 'sectors'];

function parseCsvList(value) {
 if (value === undefined || value === null) return undefined;
 if (Array.isArray(value)) {
 const items = value.map((v) => String(v || '').trim()).filter(Boolean);
 return items.slice(0, 20).map((v) => v.slice(0, 60));
 }
 const raw = String(value);
 const items = raw.split(',').map((v) => v.trim()).filter(Boolean);
 return items.slice(0, 20).map((v) => v.slice(0, 60));
}

function normalizeFrequency(value) {
 if (value === undefined || value === null) return undefined;
 const v = String(value).trim().toLowerCase();
 // 'immediate' (#5012 phase 2) is the CompanyAlert cadence: it routes the alert
 // to scripts/send-company-alerts.mjs (event-driven on a new job) instead of the
 // daily digest. Accepted here so an alert created or edited through the
 // /preferenze-newsletter/ token link round-trips the same shape the in-app
 // path writes — rejecting it would have made the token path silently rewrite a
 // followed employer back onto the digest, the "same field, two writers,
 // different values" failure #5151 was extracted to prevent.
 if (v === 'daily' || v === 'weekly' || v === 'immediate') return v;
 return null; // explicit invalid sentinel
}

function normalizeBool(value) {
 if (value === undefined || value === null) return undefined;
 if (value === true || value === 'true' || value === '1' || value === 1) return true;
 if (value === false || value === 'false' || value === '0' || value === 0) return false;
 return undefined;
}

/**
 * Canonical CompanyAlert key (#5012).
 *
 * MUST stay byte-equivalent to `baseCompanySlug`
 * (build-plugins/shared/companyProfileSlug.mjs) — the Cloud Functions bundle
 * cannot import anything outside `functions/`, so this is a deliberate,
 * pinned mirror rather than a fourth independent normalisation. Parity is
 * asserted by tests/company-alert.test.ts. The brand-alias fold is NOT
 * mirrored: the token API stores what the client canonicalised, and a key that
 * arrives already folded passes through unchanged.
 */
function normalizeCompanyAlertKey(value) {
 const norm = (x) => String(x || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();
 const n = norm(value);
 if (!n) return '';
 if (n.includes('lidl')) return 'lidl';
 return n.replace(/\s+/g, '-');
}

function serializeAlertDoc(id, data) {
 const created = data?.createdAt;
 const lastMatched = data?.lastMatchedAt;
 return {
 id,
 keywords: Array.isArray(data?.keywords) ? data.keywords : [],
 locations: Array.isArray(data?.locations) ? data.locations : [],
 sectors: Array.isArray(data?.sectors) ? data.sectors : [],
 frequency: typeof data?.frequency === 'string' ? data.frequency : 'weekly',
 frequencyOverride: data?.frequencyOverride === true,
 // `active` is SOLELY the soft-delete flag written by
 // services/jobAlertService.ts's deleteAlert() — never a pause signal.
 // `paused` is the dedicated, orthogonal pause/resume flag written by
 // update_alert below. Issue #4298 follow-up fix.
 active: data?.active !== false,
 paused: data?.paused === true,
 // Pinned scope (#5012). Omitting these made a company/job alert look like an
 // unfiltered alert to /preferenze-newsletter/, so the user could not see or
 // manage what they had followed.
 specificCompanyKey: typeof data?.specificCompanyKey === 'string' && data.specificCompanyKey
 ? data.specificCompanyKey
 : null,
 specificJobId: typeof data?.specificJobId === 'string' && data.specificJobId
 ? data.specificJobId
 : null,
 email: typeof data?.email === 'string' ? data.email : null,
 createdAt: created && typeof created.toMillis === 'function'
 ? new Date(created.toMillis()).toISOString()
 : (typeof created === 'string' ? created : null),
 lastMatchedAt: lastMatched && typeof lastMatched.toMillis === 'function'
 ? new Date(lastMatched.toMillis()).toISOString()
 : (typeof lastMatched === 'string' ? lastMatched : null),
 };
}

/**
 * How close to the opt-out a re-subscribe has to land, from the SAME user
 * agent, before it is read as a scan rather than a change of mind (#5711).
 *
 * 10 seconds, and deliberately short. The POST requirement is what actually
 * stops the scanners; this is the second layer, aimed at the one that does
 * submit forms. A window measured in minutes would start refusing real
 * misclicks — somebody who opts out, reads the confirmation, and immediately
 * realises they meant the other list — and the production signature being
 * defended against is 1,5 seconds, not 5 minutes. A refusal is recoverable
 * anyway: the page comes back with the form on it, and the next press lands
 * outside the window.
 */
const RESUBSCRIBE_BURST_WINDOW_MS = 10_000;

export async function handleSubscriptionManagement({ action, email, token, locale, secret, method = 'GET', autologinPolicy = undefined, enabled = undefined, subscribed = undefined, alertId = undefined, keywords = undefined, locations = undefined, sectors = undefined, frequency = undefined, frequencyOverride = undefined, active = undefined, paused = undefined, specificCompanyKey = undefined, specificJobId = undefined, dailyBriefFrequency = undefined, forensics = undefined, db: injectedDb }) {
 const db = injectedDb || getAdminDb();
 // Defaults to GET, i.e. FAIL-CLOSED. A caller that forgets to thread the verb
 // through cannot re-subscribe anybody; the opposite default would make the
 // #5711 guard silently vacuous the first time this function grows a second
 // entrypoint, which is the failure mode the EDGE_PUSHED_FILES gate had.
 const httpMethod = String(method || 'GET').trim().toUpperCase();
 // Allowlist-copied and error-swallowing by construction (see forensicsFields):
 // a hostile or broken forensics object contributes {} and every action below
 // behaves exactly as it did before.
 const forensicFields = forensicsFields(forensics);
 const normalizedEmail = normalizeEmail(email);

 // Try to get locale from subscriber record
 let lang = normalizeLocale(locale);
 if (!locale && normalizedEmail && normalizedEmail.includes('@')) {
 try {
 const subDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 if (subDoc.exists) {
 const subData = subDoc.data();
 lang = normalizeLocale(subData.preferred_locale || subData.signup_locale);
 }
 } catch { /* fallback to 'it' */ }
 }

 const validActions = ['unsubscribe', 'resubscribe', 'confirm', 'exchange_auth_code', 'get_autologin_status', 'toggle_autologin', 'revoke_autologin', 'get_full_status', 'toggle_newsletter_subscription', 'delete_alert', 'update_alert', 'create_alert', 'set_daily_brief_frequency'];
 if (!validActions.includes(action)) {
 return { status: 400, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorInvalidAction'), showResubscribe: false, email: '', token: '', locale: lang }) };
 }

 if (!normalizedEmail || !normalizedEmail.includes('@')) {
 return { status: 400, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorMissingParams'), showResubscribe: false, email: '', token: '', locale: lang }) };
 }

 // ── exchange_auth_code: grade the autologin code, return a fresh custom token ──
 //
 // This is the ONLY place an `ac` string becomes a Firebase session, so it is
 // the only place the credential's lifetime can be enforced (#5685). The
 // grading itself lives in lib/autologinCode.js; what happens here is the
 // policy read, the per-subscriber state read, and the refusal.
 if (action === 'exchange_auth_code') {
 const policy = autologinPolicy || resolveAutologinPolicy();

 // Signature first, WITHOUT touching Firestore: a forged code must cost a
 // hash and nothing else, or this endpoint becomes a free read amplifier for
 // anyone who can guess an address.
 const verdict = verifyAutologinCode(normalizedEmail, token, { secret, policy });
 if (!verdict.authentic) {
 return { status: 403, json: { success: false, error: 'invalid_auth_code' } };
 }

 // ONE read of the subscriber document serves both per-subscriber gates — the
 // pre-existing `autologin_enabled` opt-out and the new
 // `autologin_revoked_before` watermark — so revocation costs no extra read.
 let optedOut = false;
 let revokedBefore = null;
 try {
 const subDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 if (subDoc.exists) {
 const data = subDoc.data() || {};
 optedOut = data.autologin_enabled === false;
 revokedBefore = revokedBeforeMs(data.autologin_revoked_before);
 }
 } catch { /* read failure: signature verdict alone, exactly as before */ }

 // A legacy code carries no issue date, so ANY watermark revokes it — that is
 // what "revoke every link already sent" has to mean.
 const revoked = revokedBefore !== null
 && (verdict.issuedAtMs === null || verdict.issuedAtMs < revokedBefore);

 // Enforce opt-out: even with an authentic code, refuse to mint a custom token
 // when the subscriber has disabled autologin. This invalidates previously
 // sent links (forwarded/archived) the moment the flag flips.
 //
 // `optOutEligible: true` on every refusal below is the contract the SPA
 // needs: the code cannot open a session, but it is still good enough to
 // record an opt-out (verifyOptOutCredential), so App.tsx must offer the exit
 // instead of "Link non valido".
 if (optedOut) {
 return { status: 403, json: { success: false, error: 'autologin_disabled', optOutEligible: true } };
 }
 if (revoked) {
 return { status: 403, json: { success: false, error: 'auth_code_revoked', optOutEligible: true } };
 }
 if (verdict.expired) {
 return { status: 403, json: { success: false, error: 'auth_code_expired', optOutEligible: true } };
 }

 try {
 ensureAdminApp();
 let uid = null;
 try {
 const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
 uid = userRecord.uid;
 } catch {
 const newUser = await admin.auth().createUser({ email: normalizedEmail, emailVerified: true });
 uid = newUser.uid;
 }
 if (uid) {
 const authToken = await admin.auth().createCustomToken(uid);
 return { status: 200, json: { success: true, authToken } };
 }
 return { status: 500, json: { success: false, error: 'uid_not_found' } };
 } catch (authErr) {
 console.error('[exchange_auth_code] Failed:', authErr?.message);
 return { status: 500, json: { success: false, error: 'token_generation_failed' } };
 }
 }

 // The opt-out is the one action whose credential check is WIDER than the
 // email HMAC: an authentic autologin code of any age also gets somebody out
 // (verifyOptOutCredential, #5685). Every other action — resubscribe and the
 // whole preferences API — still needs the email HMAC and nothing else.
 const optOut = action === 'unsubscribe'
 ? verifyOptOutCredential(normalizedEmail, token, secret)
 : { ok: verifyHmacToken(normalizedEmail, token, secret), viaEmailToken: true, viaAutologin: false };

 if (!optOut.ok) {
 // JSON-returning actions (called from SPA) report invalid_token as JSON.
 const jsonActions = new Set([
 'get_autologin_status',
 'toggle_autologin',
 'revoke_autologin',
 'get_full_status',
 'toggle_newsletter_subscription',
 'delete_alert',
 'update_alert',
 'create_alert',
 ]);
 if (jsonActions.has(action)) {
 return { status: 403, json: { success: false, error: 'invalid_token' } };
 }
 return { status: 403, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorInvalidToken'), showResubscribe: false, email: '', token: '', locale: lang }) };
 }

 if (action === 'get_autologin_status') {
 try {
 const subDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 // Default: enabled (field absent = true for backward compat)
 const isEnabled = subDoc.exists ? subDoc.data()?.autologin_enabled !== false : true;
 return { status: 200, json: { success: true, enabled: isEnabled } };
 } catch (err) {
 console.error('[get_autologin_status] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'read_failed' } };
 }
 }

 if (action === 'toggle_autologin') {
 const desired = enabled === true || enabled === 'true' || enabled === '1';
 try {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 autologin_enabled: desired,
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: desired ? 'autologin_enabled' : 'autologin_disabled',
 source_channel: 'preferences_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return { status: 200, json: { success: true, enabled: desired } };
 } catch (err) {
 console.error('[toggle_autologin] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'write_failed' } };
 }
 }

 // ── revoke_autologin: kill every autologin link ALREADY SENT (#5685) ──
 //
 // The second half of the credential fix. Expiry bounds how long a leaked `ac`
 // stays useful; this ends it now, for one subscriber, without waiting for the
 // TTL and without rotating NEWSLETTER_SECRET — which is shared by every
 // recipient AND by the unsubscribe tokens, so rotating it would invalidate
 // everybody's exit at once, the one thing this wave must not do.
 //
 // A watermark, not the counter #5685 proposed: a counter would have to be read
 // by all EIGHT senders that mint a code before minting it, and any sender that
 // did not would emit permanently-dead codes for that recipient. Every code
 // issued after the watermark is newer than it and works, so the next email
 // repairs autologin by itself.
 //
 // Known and deliberate: while NEWSLETTER_AC_SCHEME is `legacy`, codes carry no
 // issue date, so a revoke is PERMANENT for that subscriber until the scheme
 // flips to v1 — a legacy code can never be newer than the watermark. That is
 // why revocation and the v1 scheme are one rollout step.
 if (action === 'revoke_autologin') {
 try {
 const now = new Date();
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 autologin_revoked_before: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'autologin_revoked',
 source_channel: 'preferences_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: now.toISOString(),
 });

 return { status: 200, json: { success: true, revokedAt: now.toISOString() } };
 } catch (err) {
 console.error('[revoke_autologin] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'write_failed' } };
 }
 }

 if (action === 'get_full_status') {
 try {
 const subDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 let newsletter = { subscribed: false, autologinEnabled: true };
 if (subDoc.exists) {
 const data = subDoc.data() || {};
 const status = data.status;
 // Both spellings (#5673): 458 documents carry only the camelCase stamp
 // the SPA path used to write, and reading one name told those people the
 // preferences page still had them subscribed.
 //
 // Shared predicate since #5711, and it has to be: the opt-out stamp is no
 // longer deleted by a re-subscription, so `stamp present` on its own would
 // now tell everyone who ever came back that they are unsubscribed — on the
 // page whose entire job is to say whether they are.
 const optOutBinding = isNewsletterOptOutBinding(data);
 const isActive = data.isActive === true || data.active === true;
 // Subscribed unless explicitly unsubscribed.
 const subscribed = !optOutBinding && (isActive || status === 'confirmed' || status === 'pending');
 newsletter = {
 subscribed,
 autologinEnabled: data.autologin_enabled !== false,
 // Daily brief cadence (#5415 §3.7). `dailyBriefFrequency` is null when the
 // engine is driving; a string when the reader pinned one. `dailyBriefTier`
 // is what the engine currently computes, shown so "automatic" is not an
 // opaque promise — the reader can see the frequency it produced.
 dailyBriefFrequency: typeof data.daily_brief_frequency_override === 'string'
 ? data.daily_brief_frequency_override
 : null,
 dailyBriefTier: Number.isFinite(data.daily_brief_tier) ? data.daily_brief_tier : null,
 };
 }

 const alertsSnap = await db.collection('job_alert_subscribers').doc(normalizedEmail).collection('alerts').get();
 const alerts = [];
 alertsSnap.forEach((d) => {
 const a = d.data() || {};
 // Issue #4298 follow-up fix: `active` is SOLELY the soft-delete flag written
 // by services/jobAlertService.ts's deleteAlert() (updateDoc active:false +
 // unsubscribed_at) — a soft-deleted doc must never reappear here. Pause is
 // tracked by the dedicated, orthogonal `paused` field written by update_alert
 // / authUpdateAlert; a paused-but-not-deleted alert (active:true, paused:true)
 // stays visible so the user can resume it.
 if (a.active === false) return;
 const created = a.createdAt;
 alerts.push({
 id: d.id,
 keywords: Array.isArray(a.keywords) ? a.keywords : [],
 locations: Array.isArray(a.locations) ? a.locations : [],
 sectors: Array.isArray(a.sectors) ? a.sectors : [],
 frequency: typeof a.frequency === 'string' ? a.frequency : 'weekly',
 frequencyOverride: a.frequencyOverride === true,
 active: true,
 paused: a.paused === true,
 createdAt: created && typeof created.toMillis === 'function' ? created.toMillis() : null,
 });
 });

 return { status: 200, json: { success: true, email: normalizedEmail, newsletter, alerts } };
 } catch (err) {
 console.error('[get_full_status] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'read_failed' } };
 }
 }

 if (action === 'toggle_newsletter_subscription') {
 const desired = subscribed === true || subscribed === 'true' || subscribed === '1';
 // Same asymmetry as `resubscribe` (#5711): turning the newsletter back ON
 // is a state change in the direction a scanner must never be able to make,
 // so it needs a POST. Turning it OFF stays reachable by any verb — an
 // opt-out must never be harder than the mail that provoked it.
 // /preferenze-newsletter/ posts it (see toggleNewsletterSubscription in
 // services/newsletterSubscribers.ts); this endpoint is not linked from any
 // page, so no crawler constructs the URL today — the gate is here so that
 // stays true by construction rather than by nobody having tried.
 if (desired && httpMethod !== 'POST') {
 return { status: 405, json: { success: false, error: 'method_not_allowed' } };
 }
 try {
 if (desired) {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'subscribed',
 isActive: true,
 active: true,
 // Both spellings, and NEITHER opt-out stamp is deleted (#5711). The
 // re-opt-in stamp is what lifts the opt-out for every sender now —
 // `isNewsletterOptOutBinding` compares the two — so the lift is no
 // longer paid for with the evidence that the opt-out happened.
 resubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 resubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });
 } else {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'unsubscribed',
 isActive: false,
 active: false,
 unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 // Both spellings, so every opt-out writer leaves the SAME observable
 // state whichever path the recipient used (#5673). The camelCase twin
 // is what 458 historic documents and scripts/send-newsletter.mjs's
 // belt-and-suspenders filter read.
 unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 ...forensicFields,
 }, { merge: true });
 }

 // Only the opt-OUT direction gets forensics: the fields are named
 // `unsubscribe_*` and would be a lie on a resubscribe write.
 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: desired ? 'subscription_resubscribed' : 'subscription_unsubscribed',
 source_channel: 'preferences_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 ...(desired ? {} : forensicFields),
 });

 return { status: 200, json: { success: true, subscribed: desired } };
 } catch (err) {
 console.error('[toggle_newsletter_subscription] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'write_failed' } };
 }
 }

 // Daily-brief cadence, pinned by the reader (#5415 §3.7). The engine adapts
 // frequency from per-recipient click history; that is only acceptable with an
 // opt-out the reader can actually reach, and this is it. Writing `null` hands
 // the channel back to the engine; 'off' stops the brief WITHOUT touching the
 // weekly newsletter or the job alerts, which are separate subscriptions.
 if (action === 'set_daily_brief_frequency') {
 const requested = dailyBriefFrequency == null || dailyBriefFrequency === 'auto'
 ? null
 : String(dailyBriefFrequency).trim();
 const ALLOWED = ['daily', 'every-2', 'every-3', 'every-5', 'weekly', 'off'];
 if (requested !== null && !ALLOWED.includes(requested)) {
 return { status: 400, json: { success: false, error: 'invalid_frequency' } };
 }
 try {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 daily_brief_frequency_override: requested === null
 ? admin.firestore.FieldValue.delete()
 : requested,
 daily_brief_override_updated_at: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'daily_brief_frequency_set',
 frequency: requested,
 source_channel: 'preferences_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return { status: 200, json: { success: true, dailyBriefFrequency: requested } };
 } catch (err) {
 console.error('[set_daily_brief_frequency] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'write_failed' } };
 }
 }

 if (action === 'delete_alert') {
 const id = String(alertId || '').trim();
 // Defensive validation: Firestore IDs are typically alphanumeric (addDoc uses 20-char base57).
 // Allow letters, digits, dash, underscore. Reject anything else to prevent path traversal.
 if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
 return { status: 400, json: { success: false, error: 'invalid_alert_id' } };
 }
 try {
 await db.collection('job_alert_subscribers').doc(normalizedEmail).collection('alerts').doc(id).delete();
 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'job_alert_deleted',
 source_channel: 'preferences_link',
 meta: { alert_id: id },
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });
 return { status: 200, json: { success: true, alert_id: id } };
 } catch (err) {
 console.error('[delete_alert] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'delete_failed' } };
 }
 }

 if (action === 'update_alert') {
 const id = String(alertId || '').trim();
 if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
 return { status: 400, json: { success: false, error: 'invalid_alert_id' } };
 }
 const patch = {};
 const fields = [];

 const kw = parseCsvList(keywords);
 if (kw !== undefined) { patch.keywords = kw; fields.push('keywords'); }
 const loc = parseCsvList(locations);
 if (loc !== undefined) { patch.locations = loc; fields.push('locations'); }
 const sec = parseCsvList(sectors);
 if (sec !== undefined) { patch.sectors = sec; fields.push('sectors'); }

 if (frequency !== undefined && frequency !== null && frequency !== '') {
 const freq = normalizeFrequency(frequency);
 if (freq === null) {
 return { status: 400, json: { success: false, error: 'invalid_frequency' } };
 }
 patch.frequency = freq;
 fields.push('frequency');
 }

 // Explicit only — caller decides both directions: `true` pins the alert
 // to the frequency just set (manual pick), `false` resets it back to
 // engine-managed (see components/community/JobAlertForm.tsx's
 // handleResetToAuto and services/jobAlertService.ts's updateAlert).
 const frequencyOverrideBool = normalizeBool(frequencyOverride);
 if (frequencyOverrideBool !== undefined) { patch.frequencyOverride = frequencyOverrideBool; fields.push('frequencyOverride'); }

 // Issue #4298 follow-up fix: update_alert never writes `active` — that field
 // is SOLELY the soft-delete flag (services/jobAlertService.ts's deleteAlert()).
 // Pause/resume goes through the dedicated `paused` field instead, so it can
 // never collide with a real delete. `active` param is intentionally ignored here.
 void active;
 const pausedBool = normalizeBool(paused);
 if (pausedBool !== undefined) { patch.paused = pausedBool; fields.push('paused'); }

 // Pinned scope (#5012). `''`/null clears the pin and turns a CompanyAlert
 // back into a normal alert — the token-mode counterpart of updateAlert() in
 // services/jobAlertService.ts.
 if (specificCompanyKey !== undefined) {
 patch.specificCompanyKey = normalizeCompanyAlertKey(specificCompanyKey) || null;
 fields.push('specificCompanyKey');
 }
 if (specificJobId !== undefined) {
 patch.specificJobId = String(specificJobId || '').trim().slice(0, 120) || null;
 fields.push('specificJobId');
 }

 if (fields.length === 0) {
 return { status: 400, json: { success: false, error: 'no_fields_to_update' } };
 }

 try {
 const ref = db.collection('job_alert_subscribers').doc(normalizedEmail).collection('alerts').doc(id);
 await ref.set({
 ...patch,
 email: normalizedEmail,
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'job_alert_updated',
 source_channel: 'preferences_link',
 meta: { alert_id: id, fields },
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 const fresh = await ref.get();
 const alert = serializeAlertDoc(id, fresh.exists ? fresh.data() : patch);
 return { status: 200, json: { success: true, alert_id: id, alert } };
 } catch (err) {
 console.error('[update_alert] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'update_failed' } };
 }
 }

 if (action === 'create_alert') {
 const kw = parseCsvList(keywords) || [];
 const loc = parseCsvList(locations) || [];
 const sec = parseCsvList(sectors) || [];

 // A pinned alert IS its own filter (#5012): the matcher
 // (services/jobAlertMatching.mjs) hard-filters on specificCompanyKey /
 // specificJobId and bypasses keyword/geo scoring entirely, so requiring a
 // keyword or a location here rejected every "follow this employer"
 // subscription with `missing_filters` — the one shape CompanyAlert needs.
 const companyPin = normalizeCompanyAlertKey(specificCompanyKey);
 const jobPin = String(specificJobId || '').trim().slice(0, 120);
 if (kw.length === 0 && loc.length === 0 && !companyPin && !jobPin) {
 return { status: 400, json: { success: false, error: 'missing_filters' } };
 }

 let freq = 'weekly';
 if (frequency !== undefined && frequency !== null && frequency !== '') {
 const normalized = normalizeFrequency(frequency);
 if (normalized === null) {
 return { status: 400, json: { success: false, error: 'invalid_frequency' } };
 }
 freq = normalized;
 }

 try {
 const alertsCol = db.collection('job_alert_subscribers').doc(normalizedEmail).collection('alerts');
 // Enforce the cap of the KIND being created (count active docs). Two budgets:
 // following employers must not consume the keyword-alert allowance, or the
 // feature that asks users to follow ten companies breaks the next saved search
 // with a message that names neither cause nor fix.
 const creatingCompanyPin = Boolean(companyPin);
 const existing = await alertsCol.get();
 let activeCount = 0;
 existing.forEach((d) => {
 const data = d.data() || {};
 if (data.active === false) return;
 if (Boolean(data.specificCompanyKey) === creatingCompanyPin) activeCount += 1;
 });
 if (activeCount >= (creatingCompanyPin ? MAX_COMPANY_ALERTS_PER_USER : MAX_ALERTS_PER_USER)) {
 return { status: 400, json: { success: false, error: 'alert_limit_reached' } };
 }

 const docData = {
 keywords: kw,
 locations: loc,
 sectors: sec,
 // Pinned scope — null when absent, never `undefined` (Firestore rejects it).
 specificCompanyKey: companyPin || null,
 specificJobId: jobPin || null,
 frequency: freq,
 // Creation always shows an explicit frequency picker (see
 // FrequencyToggle in the preferences UI) — the pick is a manual pin
 // from the start, same as components/community/JobAlertForm.tsx.
 frequencyOverride: true,
 active: true,
 email: normalizedEmail,
 createdAt: admin.firestore.FieldValue.serverTimestamp(),
 };
 const newRef = await alertsCol.add(docData);

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'job_alert_created',
 source_channel: 'preferences_link',
 meta: { alert_id: newRef.id, fields: ALERT_LIST_FIELDS.concat(['frequency', 'frequencyOverride']) },
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 // Read back to capture server timestamp; if read fails, return data we wrote.
 let alertOut;
 try {
 const fresh = await newRef.get();
 alertOut = serializeAlertDoc(newRef.id, fresh.exists ? fresh.data() : docData);
 } catch {
 alertOut = serializeAlertDoc(newRef.id, docData);
 }
 return { status: 200, json: { success: true, alert: alertOut } };
 } catch (err) {
 console.error('[create_alert] Failed:', err?.message);
 return { status: 500, json: { success: false, error: 'create_failed' } };
 }
 }

 if (action === 'unsubscribe') {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'unsubscribed',
 isActive: false,
 active: false,
 unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 // Both spellings, so every opt-out writer leaves the SAME observable
 // state whichever path the recipient used (#5673). The camelCase twin
 // is what 458 historic documents and scripts/send-newsletter.mjs's
 // belt-and-suspenders filter read.
 unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 ...forensicFields,
 }, { merge: true });

 // The subscriber doc keeps only the LAST unsubscribe (a later opt-out
 // overwrites it — a re-subscription no longer does, since #5711); the event
 // doc is the append-only trail, so the forensics go on both — that is where
 // the scanner-vs-human analysis will run.
 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'unsubscribe',
 source_channel: 'unsubscribe_link',
 // Which of the two credentials got them out (#5685). Attribution only —
 // nothing reads it back — but it is the measurement that says how many
 // people would have hit "Link non valido" without the fallback.
 credential: optOut.viaAutologin ? 'autologin_code' : 'email_token',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 ...forensicFields,
 });

 return {
 status: 200,
 html: buildResponseHtml({
 title: `${t(lang, 'manageUnsubscribeTitle')} ✅`,
 message: `${t(lang, 'manageUnsubscribeBody')} <strong>${normalizedEmail}</strong>. ${t(lang, 'manageUnsubscribeNote')}.`,
 // The confirmation page's resubscribe button re-enters this function with
 // `token` and action=resubscribe, which accepts ONLY the email HMAC.
 // Rendering it after an autologin-code opt-out would offer a button that
 // answers "Link non valido" — the same defect, one click later.
 showResubscribe: optOut.viaEmailToken,
 email: normalizedEmail,
 token,
 locale: lang,
 }),
 };
 }

 if (action === 'confirm') {
 const subscriberDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 let alreadyConfirmed = false;

 if (subscriberDoc.exists && subscriberDoc.data()?.status === 'confirmed') {
 alreadyConfirmed = true;
 }

 if (!alreadyConfirmed) {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'confirmed',
 isActive: true,
 active: true,
 confirmed_at: admin.firestore.FieldValue.serverTimestamp(),
 confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
 // A double opt-in confirmation click IS the explicit act that lifts an
 // earlier opt-out — without something recording that, the confirmation
 // said "sei iscritto" while scripts/send-newsletter.mjs kept dropping
 // the row on the stale stamp, the silent dead end for anyone who
 // unsubscribed and later signed up again (#5673).
 //
 // It used to be recorded by DELETING the opt-out stamps. It is now
 // recorded by stamping the re-opt-in beside them (#5711): the senders
 // compare the two and the newer one wins, so the lift still happens and
 // the evidence of the original opt-out survives it.
 resubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 resubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'confirm',
 source_channel: 'confirmation_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 // Fire the welcome email within seconds of confirmation instead of
 // waiting for the nightly cron fallback (up to 24h late). Best-effort and
 // non-blocking: this action's HTTP status/HTML response must never change
 // because of a welcome-email failure — the subscriber is confirmed either
 // way, and the nightly cron / presigned-link endpoint remain as fallback
 // sends. Lazy import to keep this action's cold-start path unchanged when
 // the subscriber was already confirmed (the common re-click case).
 try {
 const { sendNewsletterWelcomeEmail } = await import('./newsletterWelcomeEmail.js');
 await sendNewsletterWelcomeEmail({ email: normalizedEmail, locale: lang, db, trigger: 'confirm' });
 } catch (welcomeErr) {
 console.warn('[newsletterManage] Welcome email dispatch failed (non-fatal):', welcomeErr?.message || welcomeErr);
 }
 }

 // Generate a custom auth token for auto-login after confirmation
 let authToken = null;
 try {
 ensureAdminApp();
 let uid = null;
 try {
 const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
 uid = userRecord.uid;
 } catch {
 const newUser = await admin.auth().createUser({ email: normalizedEmail, emailVerified: true });
 uid = newUser.uid;
 }
 if (uid) {
 authToken = await admin.auth().createCustomToken(uid);
 }
 } catch (authErr) {
 console.warn('[newsletterManage] Failed to generate auth token for confirm:', authErr?.message);
 }

 const confirmTitle = alreadyConfirmed
 ? `${t(lang, 'manageResubscribeTitle')}`
 : `${t(lang, 'manageResubscribeTitle')}`;
 const confirmMessage = alreadyConfirmed
 ? `<strong>${normalizedEmail}</strong> ${t(lang, 'manageAlreadyUnsubscribed') === t('it', 'manageAlreadyUnsubscribed') ? 'è già confermato.' : 'is already confirmed.'}`
 : `<strong>${normalizedEmail}</strong> — ${t(lang, 'manageResubscribeNote')}`;

 return {
 status: 200,
 authToken,
 alreadyConfirmed,
 html: buildResponseHtml({
 title: confirmTitle,
 message: confirmMessage,
 showResubscribe: false,
 email: normalizedEmail,
 token,
 locale: lang,
 }),
 };
 }

 if (action === 'resubscribe') {
 // ── A GET renders the form and writes NOTHING (#5711) ──────────────────
 //
 // Not a 405, and not an error page: the recipient may legitimately arrive
 // here by GET — an archived confirmation page, a forwarded link, a browser
 // that turned the POST into a GET on a redirect — and telling a human
 // "method not allowed" for wanting back on a list is absurd. They get the
 // same branded page with the same button; pressing it POSTs.
 //
 // Zero writes on this path is a property, not an omission. A scanner that
 // sweeps every URL in a message hits this branch once per link it invented;
 // if it left an event behind, the sweep would write to Firestore under the
 // recipient's document and pollute exactly the event trail #5711's
 // measurement reads.
 if (httpMethod !== 'POST') {
 return {
 status: 200,
 resubscribeApplied: false,
 html: buildResponseHtml({
 title: t(lang, 'manageResubscribeConfirmTitle'),
 message: `<strong>${normalizedEmail}</strong> — ${t(lang, 'manageResubscribeConfirmBody')}`,
 showResubscribe: true,
 email: normalizedEmail,
 token,
 locale: lang,
 }),
 };
 }

 // ── Second layer: a re-subscribe inside the burst window, from the same
 // user agent that opted out, is a scan and is refused — AND RECORDED.
 //
 // Readable only because `unsubscribed_at` and `unsubscribe_user_agent`
 // now survive a re-subscription (see below): the previous behaviour
 // deleted the stamp, so this comparison had nothing to compare against.
 // Fail-open on a read error — the POST gate is the primary defence, and a
 // Firestore blip must not cost somebody their re-subscription.
 let burst = null;
 try {
 const priorSnap = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 const prior = priorSnap.exists ? (priorSnap.data() || {}) : {};
 const optOutMs = toEpochMillis(prior.unsubscribed_at) ?? toEpochMillis(prior.unsubscribedAt);
 const priorAgent = typeof prior.unsubscribe_user_agent === 'string' ? prior.unsubscribe_user_agent : null;
 const currentAgent = typeof forensicFields.unsubscribe_user_agent === 'string'
 ? forensicFields.unsubscribe_user_agent
 : null;
 const gapMs = optOutMs == null ? null : Date.now() - optOutMs;
 if (
 gapMs != null
 && gapMs >= 0
 && gapMs < RESUBSCRIBE_BURST_WINDOW_MS
 && priorAgent
 && currentAgent
 && priorAgent === currentAgent
 ) {
 burst = { gapMs, agent: currentAgent };
 }
 } catch (readErr) {
 console.warn('[resubscribe] burst pre-check unavailable (fail-open):', readErr?.message || readErr);
 }

 if (burst) {
 // Recorded, never silently dropped: a refusal nobody can count is
 // indistinguishable from a defence that never fires. The UA goes on the
 // event under a NEUTRAL name — the `unsubscribe_*` fields would be a lie
 // on a re-subscribe write (same reason as the
 // toggle_newsletter_subscription branch above).
 try {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'resubscribe_refused',
 source_channel: 'resubscribe_link',
 refusal_reason: 'burst_same_user_agent',
 gap_ms: burst.gapMs,
 request_method: httpMethod,
 request_user_agent: burst.agent,
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });
 } catch (eventErr) {
 console.warn('[resubscribe] refusal event write failed:', eventErr?.message || eventErr);
 }

 return {
 status: 200,
 resubscribeApplied: false,
 resubscribeRefusedReason: 'burst_same_user_agent',
 html: buildResponseHtml({
 title: t(lang, 'manageResubscribeRefusedTitle'),
 message: `<strong>${normalizedEmail}</strong> — ${t(lang, 'manageResubscribeRefusedBody')}`,
 showResubscribe: true,
 email: normalizedEmail,
 token,
 locale: lang,
 }),
 };
 }

 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'confirmed',
 isActive: true,
 active: true,
 resubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 // The proof of consent, written HERE too and not only in the `confirm`
 // branch (#5677). This branch wrote `confirmed` with no stamp, and the
 // token that reaches it is an HMAC(email) checked without ever looking
 // at the previous status — so a subscriber who had NEVER confirmed
 // could unsubscribe (the link rides every transactional email, not
 // just post-confirmation ones), then click "riattiva" on the response
 // page, and land on `confirmed` with nothing backing it: the exact
 // fabricated consent #5677 exists to stop, through a live path.
 //
 // Writing the stamp is the right repair rather than refusing the
 // promotion, because a "riattiva" click IS an explicit act by the
 // recipient — which is why #5690 made `resubscribe_link` one of only
 // two signals allowed to lift a recorded opt-out
 // (isExplicitNewsletterReOptIn in services/newsletterSubscribers.ts).
 // This records the evidence for that act; it does not widen who may
 // perform it, and the opt-out guard there is untouched.
 //
 // It never went noticed because the `unsubscribe` branch above does NOT
 // delete `confirmed_at`: anyone who HAD confirmed once kept an old
 // stamp across the cycle, so only the never-confirmed were affected.
 confirmed_at: admin.firestore.FieldValue.serverTimestamp(),
 confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
 // `unsubscribed_at` / `unsubscribedAt` are NOT cleared here, and this is
 // the second half of #5711. Deleting them made the re-subscription
 // destroy the record that the person had opted out — the very evidence a
 // supervisory authority asks for, and the signal the 186 resurrected
 // opt-outs of #5672 were found by. The production case that opened
 // #5711 read back `unsubscribed_at: null` afterwards, so the fastest
 // reactivation ever recorded left the tidiest-looking document.
 //
 // The stamp is append-only from here on. What lifts it for the senders is
 // this pair of fields, which they compare AGAINST the opt-out stamp —
 // see isNewsletterOptOutBinding in lib/newsletterOptOut.js and its
 // canonical twin services/newsletterOptOut.mjs. Both spellings, because
 // scripts/send-newsletter.mjs and the SPA read different ones (#5673).
 resubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'subscribe_completed',
 source_channel: 'resubscribe_link',
 // The verb, on the event trail, so the #5711 measurement can tell a
 // deliberate submission from whatever the previous GET link was
 // collecting. Every row written from here on says POST by construction.
 request_method: httpMethod,
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return {
 status: 200,
 resubscribeApplied: true,
 html: buildResponseHtml({
 title: `${t(lang, 'manageResubscribeTitle')}`,
 message: `<strong>${normalizedEmail}</strong> — ${t(lang, 'manageResubscribeBody')} ${t(lang, 'manageResubscribeNote')}`,
 showResubscribe: false,
 email: normalizedEmail,
 token,
 locale: lang,
 }),
 };
 }
}
