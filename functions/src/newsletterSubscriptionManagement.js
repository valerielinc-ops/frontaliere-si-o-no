/**
 * newsletterSubscriptionManagement.js — HMAC-verified unsubscribe/resubscribe handler
 *
 * Provides a Cloud Function endpoint that:
 * 1. Verifies HMAC tokens for unsubscribe/resubscribe URLs
 * 2. Updates subscriber status in Firestore
 * 3. Returns a branded HTML confirmation page
 *
 * URLs are generated in send-newsletter.mjs with the NEWSLETTER_SECRET env var.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import admin from 'firebase-admin';
import { ensureAdminApp, getAdminDb } from './newsletterResendWebhookCore.js';
import { t, htmlLang, normalizeLocale } from './emailI18n.js';

const BASE_URL = 'https://frontaliereticino.ch';
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

function buildResponseHtml({ title, message, showResubscribe, email, token, locale }) {
 const lang = normalizeLocale(locale);
 const resubscribeBlock = showResubscribe
 ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
 <tr><td align="center">
 <a href="${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(email)}&token=${token}&lang=${lang}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;">
 ${t(lang, 'manageResubscribeLink')}
 </a>
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
 if (v === 'daily' || v === 'weekly') return v;
 return null; // explicit invalid sentinel
}

function normalizeBool(value) {
 if (value === undefined || value === null) return undefined;
 if (value === true || value === 'true' || value === '1' || value === 1) return true;
 if (value === false || value === 'false' || value === '0' || value === 0) return false;
 return undefined;
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
 active: data?.active !== false,
 email: typeof data?.email === 'string' ? data.email : null,
 createdAt: created && typeof created.toMillis === 'function'
 ? new Date(created.toMillis()).toISOString()
 : (typeof created === 'string' ? created : null),
 lastMatchedAt: lastMatched && typeof lastMatched.toMillis === 'function'
 ? new Date(lastMatched.toMillis()).toISOString()
 : (typeof lastMatched === 'string' ? lastMatched : null),
 };
}

export async function handleSubscriptionManagement({ action, email, token, locale, secret, enabled = undefined, subscribed = undefined, alertId = undefined, keywords = undefined, locations = undefined, sectors = undefined, frequency = undefined, active = undefined, db: injectedDb }) {
 const db = injectedDb || getAdminDb();
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

 const validActions = ['unsubscribe', 'resubscribe', 'confirm', 'exchange_auth_code', 'get_autologin_status', 'toggle_autologin', 'get_full_status', 'toggle_newsletter_subscription', 'delete_alert', 'update_alert', 'create_alert'];
 if (!validActions.includes(action)) {
 return { status: 400, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorInvalidAction'), showResubscribe: false, email: '', token: '', locale: lang }) };
 }

 if (!normalizedEmail || !normalizedEmail.includes('@')) {
 return { status: 400, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorMissingParams'), showResubscribe: false, email: '', token: '', locale: lang }) };
 }

 // ── exchange_auth_code: verify HMAC autologin code, return fresh custom token ──
 if (action === 'exchange_auth_code') {
 // The autologin code uses a different HMAC derivation than unsubscribe tokens
 const expectedCode = createHmac('sha256', secret)
 .update('autologin:' + normalizedEmail)
 .digest('hex');
 let codeValid = false;
 try {
 codeValid = timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expectedCode, 'hex'));
 } catch { /* invalid hex → codeValid stays false */ }

 if (!codeValid) {
 return { status: 403, json: { success: false, error: 'invalid_auth_code' } };
 }

 // Enforce opt-out: even with a valid HMAC, refuse to mint a custom token
 // when the subscriber has disabled autologin. This invalidates previously
 // sent links (forwarded/archived) the moment the flag flips.
 try {
 const optOutDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 if (optOutDoc.exists && optOutDoc.data()?.autologin_enabled === false) {
 return { status: 403, json: { success: false, error: 'autologin_disabled' } };
 }
 } catch { /* read failure → HMAC already authed, fall through */ }

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

 if (!verifyHmacToken(normalizedEmail, token, secret)) {
 // JSON-returning actions (called from SPA) report invalid_token as JSON.
 const jsonActions = new Set([
 'get_autologin_status',
 'toggle_autologin',
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

 if (action === 'get_full_status') {
 try {
 const subDoc = await db.collection('newsletter_subscribers').doc(normalizedEmail).get();
 let newsletter = { subscribed: false, autologinEnabled: true };
 if (subDoc.exists) {
 const data = subDoc.data() || {};
 const status = data.status;
 const hasUnsubAt = !!data.unsubscribed_at;
 const isActive = data.isActive === true || data.active === true;
 // Subscribed unless explicitly unsubscribed.
 const subscribed = status !== 'unsubscribed' && !hasUnsubAt && (isActive || status === 'confirmed' || status === 'pending');
 newsletter = {
 subscribed,
 autologinEnabled: data.autologin_enabled !== false,
 };
 }

 const alertsSnap = await db.collection('job_alert_subscribers').doc(normalizedEmail).collection('alerts').get();
 const alerts = [];
 alertsSnap.forEach((d) => {
 const a = d.data() || {};
 // Skip soft-deleted alerts (active === false set by deleteAlert).
 if (a.active === false) return;
 const created = a.createdAt;
 alerts.push({
 id: d.id,
 keywords: Array.isArray(a.keywords) ? a.keywords : [],
 locations: Array.isArray(a.locations) ? a.locations : [],
 sectors: Array.isArray(a.sectors) ? a.sectors : [],
 frequency: typeof a.frequency === 'string' ? a.frequency : 'weekly',
 active: a.active !== false,
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
 try {
 if (desired) {
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'subscribed',
 isActive: true,
 active: true,
 resubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 unsubscribed_at: admin.firestore.FieldValue.delete(),
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
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });
 }

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: desired ? 'subscription_resubscribed' : 'subscription_unsubscribed',
 source_channel: 'preferences_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return { status: 200, json: { success: true, subscribed: desired } };
 } catch (err) {
 console.error('[toggle_newsletter_subscription] Failed:', err?.message);
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

 const activeBool = normalizeBool(active);
 if (activeBool !== undefined) { patch.active = activeBool; fields.push('active'); }

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

 if (kw.length === 0 && loc.length === 0) {
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
 // Enforce 10-alert cap (count active docs).
 const existing = await alertsCol.get();
 let activeCount = 0;
 existing.forEach((d) => {
 const data = d.data() || {};
 if (data.active !== false) activeCount += 1;
 });
 if (activeCount >= MAX_ALERTS_PER_USER) {
 return { status: 400, json: { success: false, error: 'alert_limit_reached' } };
 }

 const docData = {
 keywords: kw,
 locations: loc,
 sectors: sec,
 frequency: freq,
 active: true,
 email: normalizedEmail,
 createdAt: admin.firestore.FieldValue.serverTimestamp(),
 };
 const newRef = await alertsCol.add(docData);

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'job_alert_created',
 source_channel: 'preferences_link',
 meta: { alert_id: newRef.id, fields: ALERT_LIST_FIELDS.concat(['frequency']) },
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
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'unsubscribe',
 source_channel: 'unsubscribe_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return {
 status: 200,
 html: buildResponseHtml({
 title: `${t(lang, 'manageUnsubscribeTitle')} ✅`,
 message: `${t(lang, 'manageUnsubscribeBody')} <strong>${normalizedEmail}</strong>. ${t(lang, 'manageUnsubscribeNote')}.`,
 showResubscribe: true,
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
 await db.collection('newsletter_subscribers').doc(normalizedEmail).set({
 email: normalizedEmail,
 status: 'confirmed',
 isActive: true,
 active: true,
 resubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
 email: normalizedEmail,
 event_type: 'subscribe_completed',
 source_channel: 'resubscribe_link',
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: new Date().toISOString(),
 });

 return {
 status: 200,
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
