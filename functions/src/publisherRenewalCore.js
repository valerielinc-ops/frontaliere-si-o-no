/**
 * Publisher renewal reminders — retention nudge before each subscription renewal.
 *
 * `renewsAt` is stamped on every `publisher_jobs` doc by stripePublisherCore's
 * storeRenewal() (on checkout.session.completed + invoice.paid). This module's
 * scheduled CF (`sendPublisherRenewalReminders`, wired in functions/index.js)
 * runs daily and emails publishers whose ad renews within the next 3 days,
 * pointing them at the dashboard to manage/cancel — reduces silent churn.
 *
 * Idempotency: each emailed job gets `renewalReminderSentAt` stamped, so a job
 * is never reminded twice for the same renewal window. Reminders are grouped by
 * publisher → one email per publisher per run (no spamming when several ads
 * renew together).
 */

import admin from 'firebase-admin';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
const DASHBOARD_URL = 'https://frontaliereticino.ch/i-miei-annunci';
const REMINDER_WINDOW_DAYS = 3;

function db() {
  return admin.firestore();
}

/**
 * Email publishers whose paid ads renew within REMINDER_WINDOW_DAYS, once per
 * renewal (guarded by renewalReminderSentAt). Returns the count of emails sent.
 * @param {number} [nowMs]  injectable for tests
 */
export async function sendRenewalReminders(nowMs = Date.now()) {
  const now = admin.firestore.Timestamp.fromMillis(nowMs);
  const soon = admin.firestore.Timestamp.fromMillis(nowMs + REMINDER_WINDOW_DAYS * 86400000);

  // Jobs renewing in (now, now + 3 days]. Composite index: status ASC, renewsAt ASC.
  const snap = await db()
    .collection('publisher_jobs')
    .where('status', '==', 'paid')
    .where('renewsAt', '>', now)
    .where('renewsAt', '<=', soon)
    .get();
  if (snap.empty) return 0;

  // Only those not already reminded for this window; group by publisher.
  const byPublisher = new Map(); // publisherUid → { jobRefs: [], renewsAt: number }
  for (const d of snap.docs) {
    const job = d.data();
    if (job.renewalReminderSentAt) continue; // idempotency — already reminded
    const uid = job.publisherUid;
    if (!uid) continue;
    let entry = byPublisher.get(uid);
    if (!entry) {
      entry = { jobRefs: [], renewsAt: null };
      byPublisher.set(uid, entry);
    }
    entry.jobRefs.push(d.ref);
    const renewMs = typeof job.renewsAt?.toMillis === 'function' ? job.renewsAt.toMillis() : null;
    if (renewMs != null && (entry.renewsAt == null || renewMs < entry.renewsAt)) {
      entry.renewsAt = renewMs;
    }
  }
  if (byPublisher.size === 0) return 0;

  const resendApiKey = await getRemoteConfigValue('RESEND_API_KEY');
  if (!resendApiKey) return 0;
  const { Resend } = await import('resend');
  const resend = new Resend(resendApiKey);

  let sent = 0;
  for (const [uid, entry] of byPublisher) {
    try {
      const pubSnap = await db().collection('publishers').doc(String(uid)).get();
      const to = pubSnap.exists ? pubSnap.data().email : null;
      if (!to) continue;

      const days = entry.renewsAt != null
        ? Math.max(1, Math.ceil((entry.renewsAt - nowMs) / 86400000))
        : REMINDER_WINDOW_DAYS;
      const adCount = entry.jobRefs.length;

      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to,
        subject: `Il tuo annuncio si rinnova tra ${days} giorn${days === 1 ? 'o' : 'i'}`,
        html:
          `<h2>Il tuo abbonamento si rinnova a breve</h2>` +
          `<p>${adCount > 1 ? 'I tuoi annunci si rinnovano' : 'Il tuo annuncio si rinnova'} ` +
          `tra ${days} giorn${days === 1 ? 'o' : 'i'}.</p>` +
          `<p>Puoi gestire o disdire l'abbonamento dalla tua dashboard: ` +
          `<a href="${DASHBOARD_URL}">I miei annunci</a>.</p>` +
          `<p style="font-size:12px;color:#666">Se non fai nulla, l'abbonamento si rinnova automaticamente. ` +
          `La ricevuta ti arriva separatamente da Stripe.</p>`,
      });
      if (error) continue; // leave renewalReminderSentAt unset → retry next run

      // Stamp idempotency on every reminded job.
      const batch = db().batch();
      for (const ref of entry.jobRefs) {
        batch.set(ref, { renewalReminderSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      await batch.commit();
      sent += 1;
    } catch {
      // non-fatal per publisher: don't stamp → retried next run
    }
  }
  return sent;
}
