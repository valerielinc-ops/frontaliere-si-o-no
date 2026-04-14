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

export async function handleSubscriptionManagement({ action, email, token, locale, secret, db: injectedDb }) {
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

 const validActions = ['unsubscribe', 'resubscribe', 'confirm', 'exchange_auth_code'];
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
 return { status: 403, html: buildResponseHtml({ title: t(lang, 'manageErrorTitle'), message: t(lang, 'manageErrorInvalidToken'), showResubscribe: false, email: '', token: '', locale: lang }) };
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
