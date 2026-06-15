/**
 * Publisher candidate applications — forward + GDPR retention.
 *
 * Flow: a candidate submits the in-house/forward apply form → an `applications`
 * doc is created (firestore.rules requires consentGiven == true). This module:
 *   - handleForwardApplication: emails the candidate's data to the publisher's
 *     chosen address (read SERVER-SIDE from publisher_jobs — never exposed to the
 *     client), then stamps forwardedAt. Wired as an onDocumentCreated trigger.
 *   - purgeOldApplications: deletes applications older than the retention window
 *     (GDPR data-minimisation). Wired as a daily onSchedule trigger.
 *
 * The candidate's PII is transferred to a third party (the employer) only under
 * the explicit, logged consent captured at submit time (consentGiven/consentText).
 */

import admin from 'firebase-admin';
import { randomUUID } from 'node:crypto';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
const RETENTION_DAYS = 90;
// Same bucket the client uploads CVs to (storage.rules cv-uploads/**). The admin
// app may be initialised without an explicit storageBucket, so name it here.
const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.STORAGE_BUCKET ||
  'frontaliere-ticino.firebasestorage.app';
// V4 signed-URL max lifetime is 7 days; the publisher should review promptly.
const CV_SIGNED_URL_TTL_MS = 7 * 86400000;

function db() {
  return admin.firestore();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Resolve the candidate CV reference into a clickable link for the publisher.
 * - A pasted public link (http/https) is used as-is.
 * - An uploaded file is stored as a Storage object path (storage.rules denies
 *   client reads, so the client never holds a download URL); sign a short-lived
 *   read URL here with the Admin SDK. Signing failures degrade gracefully to
 *   null (CV omitted) rather than blocking the forward email.
 * @param {string|null|undefined} cvRef
 * @returns {Promise<string|null>}
 */
export async function resolveCvLink(cvRef) {
  const v = String(cvRef ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const file = admin.storage().bucket(STORAGE_BUCKET).file(v);
  // Preferred: a short-lived V4 signed URL (GDPR-friendly expiry). Requires the
  // runtime service account to hold `iam.serviceAccounts.signBlob`
  // (roles/iam.serviceAccountTokenCreator); when that permission is missing,
  // getSignedUrl throws — log it so the silent-failure mode is detectable.
  try {
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + CV_SIGNED_URL_TTL_MS,
    });
    return url;
  } catch (e) {
    console.error('[resolveCvLink] getSignedUrl failed', e);
  }
  // Fallback (no signBlob IAM needed): mint a Firebase download-token URL from the
  // object metadata. The token is the same capability already implied by emailing
  // a link, so CV delivery keeps working even when signing is not configured.
  try {
    const [meta] = await file.getMetadata();
    let token = meta?.metadata?.firebaseStorageDownloadTokens;
    token = token ? String(token).split(',')[0] : '';
    if (!token) {
      token = randomUUID();
      await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(v)}?alt=media&token=${token}`;
  } catch (e) {
    console.error('[resolveCvLink] download-token fallback failed', e);
    return null;
  }
}

/**
 * Forward one application to the publisher. Idempotent: skips if already forwarded.
 * @param {object} appData  applications doc data
 * @param {string} appId
 */
export async function handleForwardApplication(appData, appId) {
  if (!appData || appData.forwardedAt) return { ok: true, skipped: 'already_forwarded' };
  if (appData.consentGiven !== true) return { ok: false, error: 'no_consent' };

  const jobId = appData.jobId;
  if (!jobId) return { ok: false, error: 'no_job_id' };

  const jobSnap = await db().collection('publisher_jobs').doc(String(jobId)).get();
  if (!jobSnap.exists) return { ok: false, error: 'job_not_found' };
  const job = jobSnap.data();
  // Never forward PII for an ad that isn't live (paid/published) — guards against
  // applications written against a draft/expired/unpaid ad.
  if (job.status !== 'paid' && job.status !== 'published') {
    return { ok: false, error: 'job_not_live' };
  }
  const apply = job.apply || {};

  // Only forward_email / in_house modes deliver candidate data by email.
  // external_url ads never reach this path (no in-house form shown).
  if (apply.mode !== 'forward_email' && apply.mode !== 'in_house') {
    return { ok: true, skipped: 'mode_no_forward' };
  }
  const to = String(apply.email || '').trim();
  if (!to) return { ok: false, error: 'no_publisher_email' };

  const resendApiKey = await getRemoteConfigValue('RESEND_API_KEY');
  if (!resendApiKey) return { ok: false, error: 'resend_key_missing' };

  const { Resend } = await import('resend');
  const resend = new Resend(resendApiKey);

  const jobTitle = job.title || '';
  const cvLink = await resolveCvLink(appData.cvUrl);
  const html =
    `<h2>Nuova candidatura — ${esc(jobTitle)}</h2>` +
    `<p><strong>Nome:</strong> ${esc(appData.candidateName)}</p>` +
    `<p><strong>Email:</strong> ${esc(appData.candidateEmail)}</p>` +
    (cvLink ? `<p><strong>CV:</strong> <a href="${esc(cvLink)}">Apri il CV del candidato</a></p>` : '') +
    (appData.message ? `<p><strong>Messaggio:</strong><br>${esc(appData.message)}</p>` : '') +
    `<hr><p style="font-size:12px;color:#666">Candidatura inviata tramite Frontaliere Ticino con consenso esplicito del candidato (${esc(appData.consentText || 'consenso registrato')}).</p>`;

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    replyTo: appData.candidateEmail || undefined,
    subject: `Candidatura: ${jobTitle}`,
    html,
  });
  if (error) return { ok: false, error: `resend_failed:${error.message || 'unknown'}` };

  await db().collection('applications').doc(appId).set(
    { forwardedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { ok: true, forwarded: true };
}

/** Verify the Firebase ID token in the Authorization header; null if invalid. */
async function verifyCaller(req) {
  const header = req.get('Authorization') || req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch {
    return null;
  }
}

/**
 * Mint a download link for an application's uploaded CV, for the authenticated
 * publisher who owns the target application. The client never reads cv-uploads/**
 * directly (storage.rules denies client reads), so the dashboard CV link cannot
 * be the raw object path — it calls this endpoint to obtain a server-signed URL.
 * @param {import('express').Request} req
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleGetApplicationCvUrl(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const appId = String((req.body && req.body.appId) || '').trim();
  if (!appId) return { status: 400, body: { ok: false, error: 'no_app_id' } };

  const appSnap = await db().collection('applications').doc(appId).get();
  if (!appSnap.exists) return { status: 404, body: { ok: false, error: 'application_not_found' } };
  const appData = appSnap.data();
  // Only the publisher who owns the application may read the candidate's CV
  // (mirrors firestore.rules `applications` read guard: uid == publisherUid).
  if (appData.publisherUid !== decoded.uid) {
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }

  const url = await resolveCvLink(appData.cvUrl);
  if (!url) return { status: 404, body: { ok: false, error: 'cv_unavailable' } };
  return { status: 200, body: { ok: true, url } };
}

/**
 * Delete applications older than RETENTION_DAYS (GDPR). Returns the count deleted.
 * @param {number} [retentionDays]
 * @param {number} [nowMs]  injectable for tests
 */
export async function purgeOldApplications(retentionDays = RETENTION_DAYS, nowMs = Date.now()) {
  const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - retentionDays * 86400000);
  const snap = await db().collection('applications').where('createdAt', '<', cutoff).limit(500).get();
  if (snap.empty) return 0;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}
