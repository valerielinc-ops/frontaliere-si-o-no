/**
 * sendCalculatorReport.js — E2 calculator paywall PDF delivery
 *
 * HTTP endpoint that accepts a client-generated PDF (as base64) and an email
 * address, then:
 *   1. Upserts the email into `newsletter_subscribers/{email}` with
 *      `source: 'calculator_paywall'` + metadata.
 *   2. Sends the PDF as an email attachment via Resend.
 *
 * Kept intentionally minimal: the heavy lifting (PDF rendering) is done in the
 * browser, so this endpoint only needs to wrap Resend's attachment API and
 * record the capture in Firestore.
 */

import admin from 'firebase-admin';
import { Resend } from 'resend';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { t, htmlLang, normalizeLocale } from './emailI18n.js';

const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <report@frontaliereticino.ch>';
const BRAND_BLUE = '#2563EB';
const MAX_PDF_BYTES = 2 * 1024 * 1024; // 2MB — paywall PDFs are ~20-80KB in practice

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (!email.includes('@') || email.length > 254) return false;
  // Minimal RFC-lite — the client also validates via validateEmailStrict.
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email);
}

function buildBodyHtml(locale, summary) {
  const lang = normalizeLocale(locale);
  const netCH = Number(summary?.netCH_CHF || 0);
  const netIT = Number(summary?.netIT_CHF || 0);
  const savings = Number(summary?.savingsCHF || 0);
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head><meta charset="UTF-8"><title>${t(lang, 'brandName')} — PDF report</title></head>
<body style="margin:0;padding:32px 16px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="100%" style="max-width:600px;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #dbe2ea;">
      <tr><td>
        <div style="font-size:22px;font-weight:800;color:${BRAND_BLUE};margin-bottom:4px;">${t(lang, 'brandName')}</div>
        <h1 style="font-size:24px;color:#0f172a;margin:16px 0 8px;">Il tuo confronto Italia-Svizzera</h1>
        <p style="font-size:15px;line-height:1.6;">Grazie! In allegato trovi il PDF con il confronto completo della tua simulazione.</p>
        <ul style="font-size:14px;line-height:1.8;padding-left:20px;">
          <li>Netto annuo Svizzera: <strong>CHF ${Math.round(Math.abs(netCH)).toLocaleString('it-IT')}</strong></li>
          <li>Netto annuo Italia (in CHF): <strong>CHF ${Math.round(Math.abs(netIT)).toLocaleString('it-IT')}</strong></li>
          <li>Differenza annua: <strong>CHF ${Math.round(Math.abs(savings)).toLocaleString('it-IT')}</strong></li>
        </ul>
        <p style="font-size:13px;color:#6b7280;margin-top:24px;">
          Ricevi questa email perch\u00e9 hai richiesto il report PDF su ${escapeHtml(BASE_URL)}.
          Se non sei stato tu, ignora pure questo messaggio.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

/**
 * Core logic — separated from the onRequest handler so it can be tested
 * without spinning up an emulator.
 */
export async function handleSendCalculatorReport({
  email,
  pdfBase64,
  resultSummary,
  locale,
  sourcePath,
  resendApiKey,
  db: injectedDb,
  resendClient,
}) {
  if (!validateEmail(email)) {
    return { status: 400, body: { success: false, error: 'invalid_email' } };
  }
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return { status: 400, body: { success: false, error: 'missing_pdf' } };
  }

  // Rough base64 size guard (4/3 inflation).
  const approxBytes = Math.floor((pdfBase64.length * 3) / 4);
  if (approxBytes > MAX_PDF_BYTES) {
    return { status: 413, body: { success: false, error: 'pdf_too_large' } };
  }
  if (!resendApiKey) {
    return { status: 500, body: { success: false, error: 'missing_resend_api_key' } };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const lang = normalizeLocale(locale || 'it');
  const db = injectedDb || getAdminDb();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Upsert subscriber doc with source tag.
  const subscriberRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
  const existing = await subscriberRef.get();
  const baseDoc = {
    email: normalizedEmail,
    updated_at: now,
    preferred_locale: lang,
    last_source: 'calculator_paywall',
    calculator_paywall: {
      captured_at: now,
      source_path: sourcePath || '/',
      result_summary: resultSummary || null,
    },
  };
  if (!existing.exists) {
    await subscriberRef.set({
      ...baseDoc,
      created_at: now,
      source: 'calculator_paywall',
      source_channel: 'calculator_paywall',
      status: 'pending',
      isActive: false,
      signup_locale: lang,
    });
  } else {
    // Add tag without overwriting existing status/confirmation state.
    await subscriberRef.set(baseDoc, { merge: true });
  }

  const resend = resendClient || new Resend(resendApiKey);
  const attachmentFilename = `frontaliere-ticino-confronto-${new Date().toISOString().slice(0, 10)}.pdf`;
  // Resend expects attachment.content as a Buffer (or Uint8Array) for binary
  // files. Passing a raw base64 string attaches the encoded text verbatim,
  // which produces a corrupted PDF on the recipient end. Decode once here.
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const { data: emailData, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: normalizedEmail,
    subject: 'Il tuo confronto Italia-Svizzera (PDF)',
    html: buildBodyHtml(lang, resultSummary),
    attachments: [
      {
        filename: attachmentFilename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
    tags: [
      { name: 'campaign_id', value: 'calculator_paywall' },
      { name: 'type', value: 'transactional' },
      { name: 'locale', value: lang },
    ],
  });

  if (error) {
    console.error('[sendCalculatorReport] Resend error:', error);
    return { status: 502, body: { success: false, error: 'email_send_failed' } };
  }

  await db
    .collection('newsletter_subscribers')
    .doc(normalizedEmail)
    .collection('events')
    .add({
      email: normalizedEmail,
      event_type: 'calculator_paywall_pdf_sent',
      source_channel: 'calculator_paywall',
      message_id: emailData?.id || null,
      locale: lang,
      timestamp: now,
      occurred_at: new Date().toISOString(),
    });

  return { status: 200, body: { success: true, messageId: emailData?.id || null } };
}
