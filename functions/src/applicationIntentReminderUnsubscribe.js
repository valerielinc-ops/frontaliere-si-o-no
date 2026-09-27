/**
 * HMAC-verified one-click unsubscribe for application-intent reminders.
 *
 * This preference is email-only: it does not revoke the application-intent
 * signal used for matching and it does not touch saved-jobs, newsletter or
 * job-alert state. The sender signs the uid with the same secret as the other
 * preference links, but uses a distinct purpose prefix.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { forensicsFields } from './lib/requestForensics.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const CARD_BG = '#ffffff';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

export function generateApplicationIntentReminderUnsubToken(uid, secret) {
  return createHmac('sha256', secret)
    .update(`application_intent_reminder_unsub:${uid}`)
    .digest('hex');
}

function verifyToken(uid, token, secret) {
  if (!secret || !uid || !token) return false;
  const expected = generateApplicationIntentReminderUnsubToken(uid, secret);
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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)} – Frontaliere Ticino</title>
<style>body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style></head>
<body><table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};padding:48px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;"><tr><td style="text-align:center;padding-bottom:24px;"><a href="${BASE_URL}" style="text-decoration:none;"><div style="font-size:22px;font-weight:800;color:${BRAND_ORANGE};"><span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino</div><div style="font-size:12px;color:${MUTED_COLOR};letter-spacing:.04em;">La guida del frontaliere</div></a></td></tr>
<tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:32px 28px;text-align:center;"><div style="font-size:36px;margin-bottom:12px;">${icon}</div><div style="font-size:24px;font-weight:800;color:${BRAND_DARK};padding-bottom:12px;">${escapeHtml(title)}</div><div style="font-size:15px;line-height:1.6;color:#334155;">${message}</div></td></tr>
<tr><td style="text-align:center;padding:20px 0;"><a href="${BASE_URL}/cerca-lavoro-ticino/" style="font-size:14px;color:${BRAND_ORANGE};text-decoration:none;font-weight:600;">Torna alle offerte di lavoro →</a></td></tr></table>
</td></tr></table></body></html>`;
}

/**
 * @param {{uid?: string, email?: string, token?: string, secret?: string, forensics?: Record<string, unknown>, db?: any}} [options]
 * @returns {Promise<{status: number, html: string}>}
 */
export async function handleApplicationIntentReminderUnsubscribe({
  uid,
  email,
  token,
  secret,
  forensics,
  db: injectedDb,
} = {}) {
  const db = injectedDb || getAdminDb();
  const forensicFields = forensicsFields(forensics);
  if (!uid) {
    return {
      status: 400,
      html: buildConfirmationHtml({
        title: 'Parametri mancanti',
        message: 'Il link di disiscrizione non è valido. Prova a cliccare di nuovo dall\'email.',
        success: false,
      }),
    };
  }
  if (!verifyToken(uid, token, secret)) {
    return {
      status: 403,
      html: buildConfirmationHtml({
        title: 'Link non valido',
        message: 'Il link di disiscrizione è scaduto o non valido. Puoi disattivare il promemoria dalla pagina del tuo profilo.',
        success: false,
      }),
    };
  }

  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists || userDoc.data()?.applicationIntentReminder?.optedOut === true) {
    return {
      status: 200,
      html: buildConfirmationHtml({
        title: 'Già disiscritto',
        message: 'Il promemoria sulle candidature era già disattivato. Non riceverai più questa email.',
        success: true,
      }),
    };
  }

  await userRef.set({
    applicationIntentReminder: {
      optedIn: false,
      optedOut: true,
      unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
      ...forensicFields,
    },
  }, { merge: true });

  return {
    status: 200,
    html: buildConfirmationHtml({
      title: 'Disiscrizione completata',
      message: `Non riceverai più i promemoria sulle candidature${email ? ` all'indirizzo <strong>${escapeHtml(email)}</strong>` : ''}.<br><br>Il segnale di interesse resta separato: puoi gestire entrambe le scelte dalla pagina del profilo.`,
      success: true,
    }),
  };
}
