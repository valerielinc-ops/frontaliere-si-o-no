/**
 * newsletterConfirmationEmail.js — Newsletter double opt-in confirmation email
 *
 * Sends a branded confirmation email to new newsletter subscribers via Resend.
 * Uses HMAC tokens for secure confirmation link verification.
 * Includes 1-hour cooldown to prevent spam.
 */

import { createHmac } from 'node:crypto';
import admin from 'firebase-admin';
import { Resend } from 'resend';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { t, htmlLang, normalizeLocale } from './emailI18n.js';

const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <noreply@frontaliereticino.ch>';
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

export function generateConfirmationToken(email, secret) {
  return createHmac('sha256', secret).update(email.toLowerCase().trim()).digest('hex');
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
          <a href="${BASE_URL}" style="text-decoration:none;">
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
              <a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.02em;">
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
            <a href="${BASE_URL}" style="color:${MUTED_COLOR};text-decoration:none;">frontaliereticino.ch</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendNewsletterConfirmationEmail({ email, locale, sourcePath, resendApiKey, secret, db: injectedDb }) {
  if (!email || !email.includes('@')) {
    return { success: false, error: 'invalid_email' };
  }
  if (!resendApiKey) {
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

  if (data.status === 'confirmed' && data.isActive) {
    return { success: false, error: 'already_confirmed' };
  }

  if (data.confirmation_sent_at) {
    const lastSent = data.confirmation_sent_at.toDate
      ? data.confirmation_sent_at.toDate()
      : new Date(data.confirmation_sent_at);
    if (Date.now() - lastSent.getTime() < CONFIRMATION_COOLDOWN_MS) {
      return { success: false, error: 'cooldown_active' };
    }
  }

  // Always use the locale the caller sent (= the language the user is browsing in).
  // Only fall back to subscriber's stored locale if no locale was provided.
  const emailLocale = lang || normalizeLocale(data.preferred_locale || data.signup_locale || 'it');

  const token = generateConfirmationToken(normalizedEmail, secret);
  const returnPath = (sourcePath && sourcePath !== '/') ? sourcePath : '';
  // Short param names keep total URL < 1000 chars — Mailgun silently
  // skips click-tracking for href values >= 1000 characters.
  // 'email' doubles as the auto-login email (no need for separate 'ne' param).
  let finalUrl = `${BASE_URL}${returnPath}?action=confirm_newsletter&email=${encodeURIComponent(normalizedEmail)}&token=${token}`;

  // Generate a custom auth token for passwordless auto-login on confirmation.
  // This avoids the Firebase auth action page redirect which breaks on GitHub Pages SPA.
  try {
    let uid = null;
    try {
      const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
      uid = userRecord.uid;
    } catch {
      const newUser = await admin.auth().createUser({ email: normalizedEmail, emailVerified: true });
      uid = newUser.uid;
    }
    if (uid) {
      const customToken = await admin.auth().createCustomToken(uid);
      finalUrl += `&at=${encodeURIComponent(customToken)}`;
    }
  } catch (authErr) {
    console.warn('[newsletterConfirmation] Failed to generate auth token, continuing without autologin:', authErr?.message);
  }

  const resend = new Resend(resendApiKey);
  const { data: emailData, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: normalizedEmail,
    subject: t(emailLocale, 'confirmSubject'),
    html: buildNewsletterConfirmationEmailHtml(finalUrl, emailLocale),
    tags: [
      { name: 'campaign_id', value: 'confirmation' },
      { name: 'type', value: 'transactional' },
      { name: 'locale', value: emailLocale },
    ],
  });

  if (error) {
    console.error('[newsletterConfirmation] Resend error:', error);
    return { success: false, error: 'email_send_failed' };
  }

  await subscriberRef.update({
    confirmation_sent_at: admin.firestore.FieldValue.serverTimestamp(),
    confirmation_message_id: emailData?.id || null,
    preferred_locale: emailLocale,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('newsletter_subscribers').doc(normalizedEmail).collection('events').add({
    email: normalizedEmail,
    event_type: 'confirmation_email_sent',
    source_channel: 'newsletter_confirmation',
    message_id: emailData?.id || null,
    locale: emailLocale,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    occurred_at: new Date().toISOString(),
  });

  return { success: true, messageId: emailData?.id };
}
