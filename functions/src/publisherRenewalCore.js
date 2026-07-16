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
import { bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';

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

  // Cascade-routed (2026-07-16, was a direct Resend client) — pacing +
  // fallback if Resend alone is exhausted. Cloud Functions source secrets
  // async via Remote Config; the cascade reads sync process.env.*, so the
  // bridge must run first.
  await bridgeEmailCascadeCredentialsToEnv();
  if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) return 0;

  let sent = 0;
  // Batched via db.getAll() instead of one sequential .get() per publisher —
  // same fix class as the alert-email lookup in scripts/send-job-alerts.mjs
  // (AGENTS.md #6 sibling pattern). byPublisher is bounded by distinct
  // publishers with ads renewing in the 3-day window, so one unchunked call
  // (no chunk-loop) is proportionate here.
  // Own try/catch: a batch-level failure (transient network blip) degrades
  // to "0 sent this run" (unstamped publishers retry next daily run) instead
  // of throwing past the per-publisher loop below and losing every OTHER
  // publisher's reminder too — the batched call has no equivalent to the old
  // per-publisher catch that isolated one failure from the rest.
  const uids = [...byPublisher.keys()];
  let pubSnapByUid = new Map();
  try {
    const pubSnaps = await db().getAll(...uids.map((uid) => db().collection('publishers').doc(String(uid))));
    pubSnapByUid = new Map(uids.map((uid, i) => [uid, pubSnaps[i]]));
  } catch (err) {
    console.warn(`⚠️  batched publisher lookup failed for ${uids.length} publisher(s): ${err?.message || err}`);
  }

  for (const [uid, entry] of byPublisher) {
    try {
      const pubSnap = pubSnapByUid.get(uid);
      const to = pubSnap && pubSnap.exists ? pubSnap.data().email : null;
      if (!to) continue;

      const days = entry.renewsAt != null
        ? Math.max(1, Math.ceil((entry.renewsAt - nowMs) / 86400000))
        : REMINDER_WINDOW_DAYS;
      const adCount = entry.jobRefs.length;

      const { failed } = await sendEmailCascade([{
        payload: {
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
        },
        recipient: { email: to },
        meta: {},
      }]);
      if (failed.length > 0) continue; // leave renewalReminderSentAt unset → retry next run

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
