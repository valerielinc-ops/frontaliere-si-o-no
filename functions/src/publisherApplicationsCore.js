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
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
const RETENTION_DAYS = 90;

function db() {
  return admin.firestore();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  const html =
    `<h2>Nuova candidatura — ${esc(jobTitle)}</h2>` +
    `<p><strong>Nome:</strong> ${esc(appData.candidateName)}</p>` +
    `<p><strong>Email:</strong> ${esc(appData.candidateEmail)}</p>` +
    (appData.cvUrl ? `<p><strong>CV:</strong> <a href="${esc(appData.cvUrl)}">${esc(appData.cvUrl)}</a></p>` : '') +
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
