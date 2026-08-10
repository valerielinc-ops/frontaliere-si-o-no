/**
 * savedJobsDigestUnsubscribe.js — HMAC-verified one-click unsubscribe for the
 * weekly saved-jobs digest.
 *
 * Provides a Cloud Function endpoint that:
 * 1. Verifies an HMAC token (uid signed with NEWSLETTER_SECRET)
 * 2. Sets users/{uid}.savedJobsDigest.optedOut = true in Firestore
 * 3. Returns a branded HTML confirmation page (GET) or 200 OK (POST for RFC 8058)
 *
 * Scoped strictly to this channel: flips only `savedJobsDigest.optedOut` on the
 * user's own doc, never touches `newsletter_subscribers` or
 * `job_alert_subscribers/*` — unsubscribing from the saved-jobs reminder must
 * never silently drop the newsletter or job alerts (see emailSuppression.js).
 *
 * Keyed by `uid` (not email) because saved jobs live under `users/{uid}`,
 * indexed by Firebase Auth uid — unlike job alerts, which are keyed by email.
 *
 * URLs are generated in scripts/send-saved-jobs-digest.mjs.
 *
 * RFC 8058 compliance:
 * - List-Unsubscribe: <https://...?uid=X&email=Y&token=Z>, <mailto:...>
 * - List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * - POST to the URL with body "List-Unsubscribe=One-Click" triggers unsubscribe
 *
 * Forensics (`unsubscribe_method` / `_user_agent` / `_ip`) ride along on the
 * same nested `savedJobsDigest` write, built by the caller via
 * `lib/requestForensics.js` and threaded in as an option. Attribution only —
 * nothing here reads them, so behaviour is byte-identical with or without them.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import admin from 'firebase-admin';
import { ensureAdminApp, getAdminDb } from './newsletterResendWebhookCore.js';
import { forensicsFields } from './lib/requestForensics.js';

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f1f5f9';
const CARD_BG = '#ffffff';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';

/**
 * Generate the HMAC token for saved-jobs-digest unsubscribe. Distinct prefix
 * avoids collision with job-alert / newsletter tokens signed by the same secret.
 */
export function generateSavedJobsDigestUnsubToken(uid, secret) {
  return createHmac('sha256', secret)
    .update(`saved_jobs_digest_unsub:${uid}`)
    .digest('hex');
}

function verifyToken(uid, token, secret) {
  if (!secret || !uid || !token) return false;
  const expected = generateSavedJobsDigestUnsubToken(uid, secret);
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

export async function handleSavedJobsDigestUnsubscribe({ uid, email, token, secret, forensics, db: injectedDb }) {
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

  // Idempotent success: doc gone (account deleted) or already opted out.
  // Mail providers retry POST on non-200; a 404 here would degrade sender reputation.
  if (!userDoc.exists || userDoc.data()?.savedJobsDigest?.optedOut === true) {
    return {
      status: 200,
      html: buildConfirmationHtml({
        title: 'Già disiscritto',
        message: 'Il promemoria dei lavori salvati era già disattivato. Non riceverai più questa email.',
        success: true,
      }),
    };
  }

  await userRef.set(
    {
      savedJobsDigest: {
        optedOut: true,
        unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
        ...forensicFields,
      },
    },
    { merge: true },
  );

  return {
    status: 200,
    html: buildConfirmationHtml({
      title: 'Disiscrizione completata',
      message: `Non riceverai più il promemoria settimanale dei lavori salvati${email ? ` all'indirizzo <strong>${email}</strong>` : ''}.<br><br>I tuoi lavori salvati restano nel tuo account — puoi riattivare il promemoria in qualsiasi momento dalla pagina del profilo.`,
      success: true,
    }),
  };
}
