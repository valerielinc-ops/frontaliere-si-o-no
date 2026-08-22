/**
 * inboundBounceReport.js — records an RFC 3464 delivery report (a bounce) that
 * arrived as INBOUND MAIL instead of as a provider webhook event.
 *
 * WHY THIS EXISTS — the measurement, 2026-08-21.
 *
 * Maileroo's return_path for frontaliereticino.ch is a bare local part on OUR
 * domain (`"return_path": "abuse"`, read from GET /v1/domains/83576), and the
 * zone's MX are Cloudflare Email Routing. Maileroo's own bounce collection
 * would need mx1/mx2.maileroo.com on the sending domain — the API reports both
 * as `created: false`, and they cannot be created without handing Cloudflare's
 * whole inbound surface to the ESP. So every asynchronous bounce — the ISP
 * accepts at SMTP time, then rejects and reports out-of-band — lands in
 * abuse@frontaliereticino.ch and is NEVER seen by the provider.
 *
 * Concretely, for jorgeromero@bluewin.ch on campaign weekly_2026-08-17:
 * Maileroo recorded `delivered` at 11:41:04Z, Swisscom's report arrived at
 * 11:41:04Z, and the subscriber stayed `status: confirmed`,
 * `soft_bounce_count: 0`. The Maileroo dashboard reports 87.819 delivered /
 * 24 bounced (0,027%) for the domain, which is the same blind spot counted
 * from the other side.
 *
 * The Cloudflare Email Worker (infra/cloudflare-email-worker/stop-reply-handler.js)
 * parses the report and POSTs the extracted fields here. This handler applies
 * the SAME suppression path the provider webhooks use — classifyBounceSeverity
 * → bounceUpdateFields → maybeEscalateSoftBounce
 * (functions/src/lib/bounceClassification.js), one decision point for every
 * channel — to whichever of newsletter_subscribers / job_alert_subscribers the
 * address is actually in.
 *
 * Auth + anti-forgery. `abuse@` is a public inbox: anyone can send it a
 * hand-written "bounce" for any address. Three independent limits, because the
 * shared secret only proves the Worker relayed it, never that the report is
 * genuine:
 *   1. the x-stop-secret gate (Worker → this endpoint), as outreachStopReply;
 *   2. a subscriber doc is NEVER created here — an unknown address is ignored;
 *   3. the report must correspond to mail we actually sent: either a
 *      campaign_deliveries doc for the quoted campaign, or a last_sent_at
 *      within RECENT_SEND_WINDOW_MS. A forged report for an address we have
 *      not written to recently is dropped as unsolicited.
 * Together with the deliberately-soft default of the `dsn` classifier, a
 * forgery has to guess a live campaign id AND repeat itself
 * SOFT_ESCALATION_THRESHOLD times before it can suppress anyone.
 */

import admin from 'firebase-admin';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import {
  classifyBounceSeverity,
  bounceUpdateFields,
  maybeEscalateSoftBounce,
} from './lib/bounceClassification.js';

const NEWSLETTER_COLLECTION = 'newsletter_subscribers';
const JOB_ALERT_COLLECTION = 'job_alert_subscribers';

// How recently we must have mailed an address for a report about it to be
// believed. Generous on purpose: an ISP may sit on a message for days before
// giving up (RFC 5321 §4.5.4.1 suggests 4-5 days of retries), and a report that
// arrives late is still true. Short enough that a forged report cannot name an
// address we stopped mailing months ago.
export const RECENT_SEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeRecipient(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  // RFC 3464 writes the address as `rfc822; user@host` — drop the address-type
  // prefix if the Worker passed the field through verbatim.
  const withoutType = candidate.replace(/^[a-z0-9-]+\s*;\s*/i, '').trim();
  const m = withoutType.match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/);
  return m ? m[0].toLowerCase().replace(/[).,;]+$/, '') : '';
}

/**
 * A human-readable bounce_reason, kept parseable by the same
 * HARD_BOUNCE_PATTERN regex the recovery scripts fall back on.
 */
export function buildBounceReason({ status, diagnosticCode, reportingMta, campaignId }) {
  const parts = [];
  if (status) parts.push(`status ${String(status).trim()}`);
  if (diagnosticCode) parts.push(String(diagnosticCode).trim().slice(0, 200));
  if (!parts.length) parts.push('delivery report without a machine-readable status');
  const suffix = [reportingMta && `reported by ${String(reportingMta).trim()}`, campaignId && `campaign ${campaignId}`]
    .filter(Boolean)
    .join(', ');
  return `inbound DSN: ${parts.join(' — ')}${suffix ? ` (${suffix})` : ''}`;
}

/**
 * Did we actually send to this address recently? See the anti-forgery note in
 * the file header. Returns true when the report can be corroborated.
 */
async function looksSolicited(subscriberRef, subscriberData, campaignId, nowMs) {
  const lastSent = subscriberData?.last_sent_at;
  const lastSentMs = typeof lastSent?.toMillis === 'function'
    ? lastSent.toMillis()
    : (lastSent instanceof Date ? lastSent.getTime() : 0);
  if (lastSentMs && nowMs - lastSentMs <= RECENT_SEND_WINDOW_MS) return true;
  if (!campaignId) return false;
  // Both key shapes the senders write (`<campaign>_<email>` from the cascade's
  // persistDelivery, `<campaign>__<email>` from send-newsletter's own record).
  const email = subscriberRef.id;
  for (const key of [`${campaignId}_${email}`, `${campaignId}__${email}`]) {
    const snap = await subscriberRef.collection('campaign_deliveries').doc(key).get();
    if (snap.exists) return true;
  }
  return false;
}

async function applyToCollection(db, collection, {
  email, severity, reason, status, diagnosticCode, action, campaignId, originalMessageId, reportingMta, nowMs,
}) {
  const FieldValue = admin.firestore.FieldValue;
  const ref = db.collection(collection).doc(email);
  const snap = await ref.get();
  // Never create a subscriber from inbound mail (anti-forgery limit 2).
  if (!snap.exists) return { collection, applied: false, reason: 'unknown_recipient' };
  const data = snap.data() || {};

  if (!(await looksSolicited(ref, data, campaignId, nowMs))) {
    return { collection, applied: false, reason: 'unsolicited' };
  }

  const update = {
    updated_at: FieldValue.serverTimestamp(),
    last_bounced_at: FieldValue.serverTimestamp(),
    bounce_count: FieldValue.increment(1),
    ...bounceUpdateFields({ severity, reason }),
  };
  await ref.set(update, { merge: true });

  await ref.collection('events').add({
    email,
    event_type: 'bounce',
    provider: 'dsn',
    campaign_id: campaignId || 'unknown',
    message_id: originalMessageId || null,
    metadata: {
      dsn_status: status || null,
      dsn_action: action || null,
      diagnostic_code: diagnosticCode || null,
      reporting_mta: reportingMta || null,
      severity,
      reason,
    },
    timestamp: FieldValue.serverTimestamp(),
  });

  // Same follow-up the webhooks run: a soft bounce only counts, and escalates
  // to a permanent `bounced` at SOFT_ESCALATION_THRESHOLD with no intervening
  // delivered/open/click.
  let escalated = false;
  if (severity === 'soft') escalated = await maybeEscalateSoftBounce(ref, reason);

  return { collection, applied: true, severity, escalated };
}

/**
 * Core handler. `db` and `nowMs` are injectable for unit tests.
 * Returns { status, body, result? }.
 */
export async function handleInboundBounceReport({
  recipient,
  status,
  action,
  diagnosticCode,
  campaignId,
  originalMessageId,
  reportingMta,
  secret,
  providedSecret,
  db: injectedDb,
  nowMs = Date.now(),
}) {
  if (!secret || providedSecret !== secret) return { status: 403, body: 'forbidden' };

  const email = normalizeRecipient(recipient);
  if (!email) return { status: 400, body: 'invalid recipient' };

  const db = injectedDb || getAdminDb();
  const severity = classifyBounceSeverity({
    provider: 'dsn',
    rawEvent: action,
    eventData: { status, diagnostic_code: diagnosticCode },
  });
  const reason = buildBounceReason({ status, diagnosticCode, reportingMta, campaignId });

  const results = [];
  for (const collection of [NEWSLETTER_COLLECTION, JOB_ALERT_COLLECTION]) {
    // The address is dead for every channel at once, so both are updated when
    // both exist — reputation is a property of the mailbox, not of the list.
    results.push(await applyToCollection(db, collection, {
      email, severity, reason, status, diagnosticCode, action, campaignId,
      originalMessageId, reportingMta, nowMs,
    }));
  }

  const applied = results.filter((r) => r.applied);
  if (!applied.length) {
    const why = results.every((r) => r.reason === 'unknown_recipient') ? 'unknown recipient' : 'unsolicited report';
    return { status: 200, body: `ignored: ${why}`, result: { email, applied: [], severity } };
  }

  return {
    status: 200,
    body: `ok: ${severity}`,
    result: { email, severity, applied: applied.map((r) => r.collection), escalated: applied.some((r) => r.escalated) },
  };
}
