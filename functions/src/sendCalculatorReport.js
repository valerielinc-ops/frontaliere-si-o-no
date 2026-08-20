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
 *
 * Suppression: this is a TRANSACTIONAL send (the user submitted the form and is
 * waiting for the PDF), so it is guarded only against a provably dead mailbox
 * (hard bounce) or a filed spam complaint — see `isTransactionalHardBlock` in
 * lib/emailSuppression.js. `unsubscribed`/`inactive`/`pending`/soft-bounced
 * addresses still receive their report; suppressing those would break a working
 * lead-magnet funnel over a consent signal that does not apply to this message.
 *
 * Supports multiple report kinds via the allowlisted `source` param:
 *   - 'calculator_paywall' (default) — Italy-vs-Switzerland salary report
 *   - 'lamal_ssn_tool'               — LAMal-vs-SSN health breakeven report
 * The source doubles as the newsletter acquisitionSource tag.
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { makeMailerooRefOnSent } from './lib/mailerooRef.js';
import { isTransactionalHardBlock } from './lib/emailSuppression.js';
import { t, htmlLang, normalizeLocale } from './emailI18n.js';
import { sendEmailCascade, isProviderConfigured } from './emailCascade.js';
import { bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { dataControllerFooterLine } from './lib/dataControllerIdentity.js';

const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <report@frontaliereticino.ch>';
const BRAND_BLUE = '#2563EB';
const MAX_PDF_BYTES = 2 * 1024 * 1024; // 2MB — paywall PDFs are ~20-80KB in practice

const ALLOWED_SOURCES = new Set(['calculator_paywall', 'lamal_ssn_tool']);

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
        <p style="font-size:11px;color:#94a3b8;margin-top:12px;">${escapeHtml(dataControllerFooterLine(lang))}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

function buildLamalSsnBodyHtml(locale, summary) {
  const lang = normalizeLocale(locale);
  const lamalAnnual = Number(summary?.lamalAnnualCHF || 0);
  const ssnMin = Number(summary?.ssnMinCHF || 0);
  const ssnMax = Number(summary?.ssnMaxCHF || 0);
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head><meta charset="UTF-8"><title>${t(lang, 'brandName')} — PDF report</title></head>
<body style="margin:0;padding:32px 16px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="100%" style="max-width:600px;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #dbe2ea;">
      <tr><td>
        <div style="font-size:22px;font-weight:800;color:${BRAND_BLUE};margin-bottom:4px;">${t(lang, 'brandName')}</div>
        <h1 style="font-size:24px;color:#0f172a;margin:16px 0 8px;">Il tuo confronto LAMal vs SSN</h1>
        <p style="font-size:15px;line-height:1.6;">Grazie! In allegato trovi il PDF con il confronto personalizzato tra LAMal svizzera e SSN italiano.</p>
        <ul style="font-size:14px;line-height:1.8;padding-left:20px;">
          <li>Costo LAMal stimato: <strong>CHF ${Math.round(Math.abs(lamalAnnual)).toLocaleString('it-IT')}/anno</strong></li>
          <li>Contributo SSN stimato (3–6%): <strong>CHF ${Math.round(Math.abs(ssnMin)).toLocaleString('it-IT')} – ${Math.round(Math.abs(ssnMax)).toLocaleString('it-IT')}/anno</strong></li>
        </ul>
        <p style="font-size:13px;color:#6b7280;margin-top:24px;">
          Ricevi questa email perch\u00e9 hai richiesto il report PDF su ${escapeHtml(BASE_URL)}.
          Se non sei stato tu, ignora pure questo messaggio.
        </p>
        <p style="font-size:11px;color:#94a3b8;margin-top:12px;">${escapeHtml(dataControllerFooterLine(lang))}</p>
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
  source,
  db: injectedDb,
}) {
  // Allowlisted acquisition source — unknown values fall back to the
  // original paywall tag so the endpoint stays backwards-compatible.
  const src = ALLOWED_SOURCES.has(source) ? source : 'calculator_paywall';
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
  // Cascade-routed (2026-07-16, was a direct Resend client) — but PDF
  // attachments are Resend-only in the cascade (no other provider's
  // sendVia* forwards email.attachments), so this still hard-requires
  // Resend specifically, not "any provider". Cloud Functions source
  // secrets async via Remote Config; the cascade reads sync process.env.*,
  // so the bridge must run first.
  await bridgeEmailCascadeCredentialsToEnv();
  if (!isProviderConfigured('resend')) {
    return { status: 500, body: { success: false, error: 'missing_resend_api_key' } };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const lang = normalizeLocale(locale || 'it');
  const db = injectedDb || getAdminDb();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Upsert subscriber doc with source tag. Firestore errors are converted to
  // a structured 5XX so the HTTP handler can return a stable JSON shape
  // instead of leaking a raw stack trace.
  const subscriberRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
  const baseDoc = {
    email: normalizedEmail,
    updated_at: now,
    preferred_locale: lang,
    last_source: src,
    [src]: {
      captured_at: now,
      source_path: sourcePath || '/',
      result_summary: resultSummary || null,
    },
  };
  // Single read, shared by the suppression guard below and the upsert branch —
  // and it FAILS OPEN: a Firestore hiccup leaves `existing` null and the PDF
  // still ships. This is a transactional email the user submitted a form for
  // seconds ago; a lookup failure must never silently swallow it.
  let existing = null;
  let existingReadFailed = false;
  try {
    existing = await subscriberRef.get();
  } catch (readErr) {
    existingReadFailed = true;
    console.warn(
      '[sendCalculatorReport] subscriber read failed — suppression guard fails OPEN:',
      readErr?.message || readErr,
    );
  }

  // NARROW hard-block guard: only a provably dead mailbox (hard bounce) or a
  // filed spam complaint. `unsubscribed` / `inactive` / `pending` / a soft
  // bounce all still get their PDF — a marketing opt-out does not revoke a
  // transactional request the user just made. Rationale + exact set live in
  // lib/emailSuppression.js (isTransactionalHardBlock); do not widen it here.
  if (existing?.exists) {
    const existingData = existing.data() || {};
    if (isTransactionalHardBlock({
      status: existingData.status,
      bounceSeverity: existingData.bounce_severity,
    })) {
      console.warn(`[sendCalculatorReport] suppressed address, send skipped: status=${existingData.status}`);
      return { status: 403, body: { success: false, error: 'address_suppressed' } };
    }
  }

  try {
    if (existingReadFailed) {
      // Existence unknown. Merge the source tag only — writing the create-only
      // fields blind (`status: 'pending'`, `isActive: false`) would downgrade a
      // confirmed subscriber, which is worse than a slightly thinner doc.
      await subscriberRef.set(baseDoc, { merge: true });
    } else if (!existing.exists) {
      await subscriberRef.set({
        ...baseDoc,
        created_at: now,
        source: src,
        source_channel: src,
        status: 'pending',
        isActive: false,
        signup_locale: lang,
      });
    } else {
      // Add tag without overwriting existing status/confirmation state.
      await subscriberRef.set(baseDoc, { merge: true });
    }
  } catch (firestoreErr) {
    console.error('[sendCalculatorReport] Firestore upsert failed:', firestoreErr);
    return { status: 503, body: { success: false, error: 'firestore_unavailable' } };
  }

  const isLamal = src === 'lamal_ssn_tool';
  const attachmentFilename = isLamal
    ? `frontaliere-ticino-lamal-ssn-${new Date().toISOString().slice(0, 10)}.pdf`
    : `frontaliere-ticino-confronto-${new Date().toISOString().slice(0, 10)}.pdf`;
  // The cascade's sendViaResend calls Resend's raw REST API (fetch + JSON),
  // not the SDK — the REST API's attachments[].content wants a base64
  // STRING (unlike the SDK, which accepts a Buffer and encodes it for you).
  // pdfBase64 already IS that string, so no decode/re-encode is needed here.
  const { sent, failed } = await sendEmailCascade([{
    payload: {
      from: FROM_EMAIL,
      to: normalizedEmail,
      subject: isLamal ? 'Il tuo confronto LAMal vs SSN (PDF)' : 'Il tuo confronto Italia-Svizzera (PDF)',
      html: isLamal ? buildLamalSsnBodyHtml(lang, resultSummary) : buildBodyHtml(lang, resultSummary),
      attachments: [
        {
          filename: attachmentFilename,
          content: pdfBase64,
        },
      ],
      tags: [
        { name: 'campaign_id', value: src },
        { name: 'type', value: 'transactional' },
        { name: 'locale', value: lang },
      ],
    },
    recipient: { email: normalizedEmail },
    meta: {},
  }], {
    forceProvider: 'resend',
    // A no-op while `forceProvider: 'resend'` stands — recordMailerooRef exits
    // on any provider but Maileroo. It is wired anyway because that flag is the
    // only thing keeping this sender off Maileroo, and dropping it would
    // otherwise take this channel's opens and clicks with it, silently. See
    // functions/src/lib/mailerooRef.js.
    onSent: makeMailerooRefOnSent(async () => db, {
      defaultCampaignId: src,
      isJobAlert: false,
    }),
  });

  if (failed.length > 0) {
    console.error('[sendCalculatorReport] send error:', failed[0].error);
    return { status: 502, body: { success: false, error: 'email_send_failed' } };
  }
  const emailData = { id: sent[0]?.messageId };

  // Best-effort event write — if Firestore is temporarily unavailable the
  // email has already shipped, so we log and still return 200 to the client
  // rather than failing the user-visible request.
  try {
    await db
      .collection('newsletter_subscribers')
      .doc(normalizedEmail)
      .collection('events')
      .add({
        email: normalizedEmail,
        event_type: `${src}_pdf_sent`,
        source_channel: src,
        message_id: emailData?.id || null,
        locale: lang,
        timestamp: now,
        occurred_at: new Date().toISOString(),
      });
  } catch (eventErr) {
    console.warn('[sendCalculatorReport] Non-fatal: event log write failed:', eventErr?.message || eventErr);
  }

  return { status: 200, body: { success: true, messageId: emailData?.id || null } };
}
