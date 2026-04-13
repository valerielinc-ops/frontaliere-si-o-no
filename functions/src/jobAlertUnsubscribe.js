/**
 * jobAlertUnsubscribe.js — HMAC-verified one-click unsubscribe for job alerts
 *
 * Provides a Cloud Function endpoint that:
 * 1. Verifies HMAC tokens (alertId + email signed with NEWSLETTER_SECRET)
 * 2. Sets alert.active = false in Firestore
 * 3. Returns a branded HTML confirmation page (GET) or 200 OK (POST for RFC 8058)
 *
 * URLs are generated in send-job-alerts.mjs.
 *
 * RFC 8058 compliance:
 * - List-Unsubscribe: <https://...?alertId=X&email=Y&token=Z>, <mailto:...>
 * - List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * - POST to the URL with body "List-Unsubscribe=One-Click" triggers unsubscribe
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import admin from 'firebase-admin';
import { ensureAdminApp, getAdminDb } from './newsletterResendWebhookCore.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const CARD_BG = '#ffffff';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';

/**
 * Generate HMAC token for job alert unsubscribe (single alert).
 * Uses a distinct prefix to avoid collision with newsletter tokens.
 */
export function generateAlertUnsubToken(alertId, email, secret) {
  return createHmac('sha256', secret)
    .update(`job_alert_unsub:${alertId}:${email.toLowerCase().trim()}`)
    .digest('hex');
}

/**
 * Generate HMAC token for unsubscribing from ALL job alerts.
 */
export function generateAllAlertsUnsubToken(email, secret) {
  return createHmac('sha256', secret)
    .update(`job_alert_unsub_all:${email.toLowerCase().trim()}`)
    .digest('hex');
}

function verifyAlertToken(alertId, email, token, secret) {
  if (!secret || !alertId || !email || !token) return false;
  const expected = generateAlertUnsubToken(alertId, email, secret);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function verifyAllAlertsToken(email, token, secret) {
  if (!secret || !email || !token) return false;
  const expected = generateAllAlertsUnsubToken(email, secret);
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function buildConfirmationHtml({ title, message, success }) {
  const icon = success ? '✅' : '⚠️';
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} – Frontaliere Ticino</title>
  <style>body { margin:0; padding:0; background:${LIGHT_BG}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }</style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};padding:48px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="text-align:center;padding-bottom:24px;">
          <a href="${BASE_URL}" style="text-decoration:none;">
            <div style="font-size:22px;font-weight:800;color:${BRAND_ORANGE};">
              <span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino
            </div>
            <div style="font-size:12px;color:${MUTED_COLOR};letter-spacing:.04em;">La guida del frontaliere</div>
          </a>
        </td></tr>
        <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:32px 28px;text-align:center;">
          <div style="font-size:36px;margin-bottom:12px;">${icon}</div>
          <div style="font-size:24px;font-weight:800;color:${BRAND_DARK};padding-bottom:12px;">${title}</div>
          <div style="font-size:15px;line-height:1.6;color:#334155;">${message}</div>
        </td></tr>
        <tr><td style="text-align:center;padding:20px 0;">
          <a href="${BASE_URL}/cerca-lavoro-ticino/" style="font-size:14px;color:${BRAND_ORANGE};text-decoration:none;font-weight:600;">Torna alle offerte di lavoro →</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function handleJobAlertUnsubscribe({ alertId, email, token, secret, action, db: injectedDb }) {
  const db = injectedDb || getAdminDb();

  // ── Unsubscribe from ALL alerts ───────────────────────────
  if (action === 'unsubscribe_all') {
    if (!email || !email.includes('@')) {
      return {
        status: 400,
        html: buildConfirmationHtml({
          title: 'Parametri mancanti',
          message: 'Il link di disiscrizione non è valido. Prova a cliccare di nuovo dall\'email.',
          success: false,
        }),
      };
    }

    if (!verifyAllAlertsToken(email, token, secret)) {
      return {
        status: 403,
        html: buildConfirmationHtml({
          title: 'Link non valido',
          message: 'Il link di disiscrizione è scaduto o non valido. Puoi disattivare le alert dalla pagina del tuo profilo.',
          success: false,
        }),
      };
    }

    // Find all active alerts for this email
    const alertsSnap = await db.collection('job_alerts')
      .where('email', '==', email.toLowerCase().trim())
      .where('active', '==', true)
      .get();

    if (alertsSnap.empty) {
      return {
        status: 200,
        html: buildConfirmationHtml({
          title: 'Nessuna alert attiva',
          message: `Non ci sono alert attive per <strong>${email}</strong>. Non riceverai email.`,
          success: true,
        }),
      };
    }

    // Deactivate all alerts in batch
    const batch = db.batch();
    for (const doc of alertsSnap.docs) {
      batch.update(doc.ref, {
        active: false,
        unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
        unsubscribe_source: 'email_link_all',
      });
    }
    await batch.commit();

    return {
      status: 200,
      html: buildConfirmationHtml({
        title: 'Tutte le alert disattivate',
        message: `Abbiamo disattivato <strong>${alertsSnap.size}</strong> alert per <strong>${email}</strong>.<br><br>Non riceverai più notifiche di lavoro. Puoi sempre crearne di nuove dalla pagina offerte di lavoro.`,
        success: true,
      }),
    };
  }

  // ── Unsubscribe from a single alert ───────────────────────
  if (!alertId || !email || !email.includes('@')) {
    return {
      status: 400,
      html: buildConfirmationHtml({
        title: 'Parametri mancanti',
        message: 'Il link di disiscrizione non è valido. Prova a cliccare di nuovo dall\'email.',
        success: false,
      }),
    };
  }

  if (!verifyAlertToken(alertId, email, token, secret)) {
    return {
      status: 403,
      html: buildConfirmationHtml({
        title: 'Link non valido',
        message: 'Il link di disiscrizione è scaduto o non valido. Puoi disattivare l\'alert dalla pagina del tuo profilo.',
        success: false,
      }),
    };
  }

  // Verify the alert exists and belongs to this email
  const alertRef = db.collection('job_alerts').doc(alertId);
  const alertDoc = await alertRef.get();

  if (!alertDoc.exists) {
    return {
      status: 404,
      html: buildConfirmationHtml({
        title: 'Alert non trovata',
        message: 'Questa alert non esiste più. Potrebbe essere già stata rimossa.',
        success: false,
      }),
    };
  }

  const alertData = alertDoc.data();
  if (alertData.email?.toLowerCase() !== email.toLowerCase().trim()) {
    return {
      status: 403,
      html: buildConfirmationHtml({
        title: 'Non autorizzato',
        message: 'Questo link non corrisponde alla tua email.',
        success: false,
      }),
    };
  }

  if (!alertData.active) {
    return {
      status: 200,
      html: buildConfirmationHtml({
        title: 'Già disiscritto',
        message: `L'alert per <strong>${email}</strong> era già disattivata. Non riceverai più email per questa alert.`,
        success: true,
      }),
    };
  }

  // Deactivate the alert
  await alertRef.update({
    active: false,
    unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
    unsubscribe_source: 'email_link',
  });

  const filterDesc = [
    ...(alertData.keywords || []),
    ...(alertData.locations || []),
    ...(alertData.sectors || []),
  ].filter(Boolean).join(', ') || 'tutte le offerte';

  return {
    status: 200,
    html: buildConfirmationHtml({
      title: 'Disiscrizione completata',
      message: `Non riceverai più alert per <strong>${filterDesc}</strong> all'indirizzo <strong>${email}</strong>.<br><br>Puoi sempre creare una nuova alert dalla pagina offerte di lavoro.`,
      success: true,
    }),
  };
}
