import admin from 'firebase-admin';
import { Resend } from 'resend';
import { refreshEngagementScore } from './lib/engagementScore.js';
import { refreshPreferredSendHour } from './lib/preferredSendHour.js';
import { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS, lookupSentVariant } from './lib/emailExperimentPostHog.js';
import { buildDeliveryDocId as buildCanonicalDeliveryDocId, uniqueUnknownFallback } from './lib/deliveryDocId.js';
import { classifyBounceSeverity, bounceUpdateFields, softBounceRecoveryFields, maybeEscalateSoftBounce } from './lib/bounceClassification.js';
import {
  positiveEventRecoveryFields,
  positiveEventStatusFields,
  HUMAN_DECLARED_SUPPRESSIONS,
  MACHINE_INFERRED_SUPPRESSIONS,
} from './lib/subscriberReactivation.js';
import { normalizeEmailAddress } from './lib/parseEmailField.js';

function sanitizeString(value) {
 const normalized = String(value || '').trim();
 return normalized || null;
}

export function ensureAdminApp() {
 if (!admin.apps.length) {
 admin.initializeApp({ credential: admin.credential.applicationDefault() });
 }
 return admin;
}

export function getAdminDb() {
 return ensureAdminApp().firestore();
}

function getHeader(headers, key) {
 if (!headers) return '';
 if (typeof headers.get === 'function') {
 return String(headers.get(key) || headers.get(key.toLowerCase()) || '');
 }
 return String(headers[key] || headers[key.toLowerCase()] || '');
}

export function verifyResendWebhookSignature({
 payload,
 headers,
 webhookSecret = process.env.RESEND_WEBHOOK_SECRET,
}) {
 if (!webhookSecret) {
 throw new Error('Missing RESEND_WEBHOOK_SECRET');
 }
 const resend = new Resend(process.env.RESEND_API_KEY || 'webhook-verify-only');
 return resend.webhooks.verify({
 payload,
 webhookSecret,
 headers: {
 id: getHeader(headers, 'svix-id'),
 timestamp: getHeader(headers, 'svix-timestamp'),
 signature: getHeader(headers, 'svix-signature'),
 },
 });
}

function mapWebhookType(type) {
 switch (String(type || '').toLowerCase()) {
 case 'email.sent':
 return 'send';
 case 'email.delivered':
 return 'delivered';
 case 'email.opened':
 return 'open';
 case 'email.clicked':
 return 'click';
 case 'email.bounced':
 return 'bounce';
 case 'email.complained':
 return 'complaint';
 case 'email.suppressed':
 return 'suppressed';
 case 'email.failed':
 return 'failed';
 case 'email.delivery_delayed':
 return 'delivery_delayed';
 case 'email.scheduled':
 return 'scheduled';
 default:
 return null;
 }
}

function extractTagMap(tags) {
 const map = {};
 if (Array.isArray(tags)) {
 for (const tag of tags) {
 const name = sanitizeString(tag?.name);
 const value = sanitizeString(tag?.value);
 if (name && value) map[name] = value;
 }
 return map;
 }
 if (tags && typeof tags === 'object') {
 for (const [key, rawValue] of Object.entries(tags)) {
 const name = sanitizeString(key);
 const value = sanitizeString(rawValue);
 if (name && value) map[name] = value;
 }
 return map;
 }
 return map;
}

function buildDeliveryDocId(email, campaignId) {
 // Delegate to the shared canonical builder (single source of truth).
 return buildCanonicalDeliveryDocId(campaignId, email);
}

// Suppressed statuses: once a subscriber lands in one of these, the BLANKET
// "delivered/open/click → confirmed" promotion below must not fire (a queued/
// retried ESP notification racing a complaint, or a stale open replaying after
// a hard bounce, would otherwise resurrect them — issue #3305). Lifting a
// suppression is not this function's job: it is the single, audited decision in
// positiveEventRecoveryFields(), applied by the caller right after, which can
// tell a machine inference apart from a human's consent decision.
//
// `unsubscribed` is in the set now. It was missing, and since it is NOT in the
// pending/empty cases either, a delivered/open/click on an unsubscribed
// newsletter subscriber promoted them straight back to 'confirmed' +
// isActive:true — the exact same "machine overwrites a human's decision" defect
// as the job-alert branch's unconditional `status = 'active'`, in the same
// class, so it is fixed in the same pass.
const NON_PROMOTABLE_STATUSES = new Set([
  ...HUMAN_DECLARED_SUPPRESSIONS,
  ...MACHINE_INFERRED_SUPPRESSIONS,
]);

function buildSubscriberUpdate(eventType, data, currentStatus) {
 const FieldValue = admin.firestore.FieldValue;
 const update = {
 email: normalizeEmailAddress(data.email),
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 };

 if (eventType === 'send') {
 update.last_sent_at = admin.firestore.FieldValue.serverTimestamp();
 update.lastSentAt = admin.firestore.FieldValue.serverTimestamp();
 update.send_count = FieldValue.increment(1);
 update.sendCount = FieldValue.increment(1);
 }
 if (eventType === 'delivered') {
 update.last_delivered_at = admin.firestore.FieldValue.serverTimestamp();
 Object.assign(update, softBounceRecoveryFields());
 }
 if (eventType === 'open') {
 update.last_open_at = admin.firestore.FieldValue.serverTimestamp();
 update.lastOpenAt = admin.firestore.FieldValue.serverTimestamp();
 update.open_count = FieldValue.increment(1);
 update.openCount = FieldValue.increment(1);
 Object.assign(update, softBounceRecoveryFields());
 }
 if (eventType === 'click') {
 update.last_click_at = admin.firestore.FieldValue.serverTimestamp();
 update.lastClickAt = admin.firestore.FieldValue.serverTimestamp();
 update.click_count = FieldValue.increment(1);
 update.clickCount = FieldValue.increment(1);
 update.last_clicked_url = sanitizeString(data.link_url || data.target_url);
 update.last_clicked_section = sanitizeString(data.section_id);
 Object.assign(update, softBounceRecoveryFields());
 }
 // Bounce classification/severity is handled by the caller (needs the raw
 // provider bounce payload, which this constructed `data` object doesn't
 // carry) — see the `type === 'bounce'` block right after this call.
 if (eventType === 'complaint') {
 update.last_complained_at = admin.firestore.FieldValue.serverTimestamp();
 update.status = 'complained';
 update.isActive = false;
 update.active = false;
 }
 if (eventType === 'suppressed') {
 update.status = 'suppressed';
 update.isActive = false;
 update.active = false;
 }
 if (eventType === 'failed') {
 update.last_failed_at = admin.firestore.FieldValue.serverTimestamp();
 update.fail_count = FieldValue.increment(1);
 }
 if (eventType === 'delivery_delayed') {
 update.last_delay_at = admin.firestore.FieldValue.serverTimestamp();
 update.delay_count = FieldValue.increment(1);
 }
 // Only promote to confirmed if the subscriber already has a non-pending status.
 // Pending subscribers (or unknown/new ones) must complete email verification
 // before being promoted — a mere delivery or open does not constitute opt-in.
 // Terminal negative statuses (complained/suppressed/bounced) must also be
 // excluded — otherwise a delivered/open/click event racing (or following)
 // a suppression event would silently resurrect the subscriber (#3305).
 if (eventType === 'delivered' || eventType === 'open' || eventType === 'click') {
 const skipPromotion = !currentStatus || currentStatus === 'pending' || NON_PROMOTABLE_STATUSES.has(currentStatus);
 if (!skipPromotion) {
 update.status = 'confirmed';
 update.isActive = true;
 update.active = true;
 }
 }

 return update;
}

export async function applyResendWebhookEvent(rawEvent, options = {}) {
 const db = options.db || getAdminDb();
 const type = mapWebhookType(rawEvent?.type);
 if (!type) {
 return { handled: false, reason: 'unsupported_event_type' };
 }

 const data = rawEvent?.data || {};
 const tags = extractTagMap(data.tags);
 const email = normalizeEmailAddress(
 data.email
 || (Array.isArray(data.to) ? data.to[0] : data.to)
 || data.recipient
 || data.rcpt_to,
 );
 if (!email || !email.includes('@')) {
 return { handled: false, reason: 'missing_recipient' };
 }

 const emailType = sanitizeString(tags.type) || 'newsletter';
 const messageId = sanitizeString(data.email_id || data.id || data.message_id);
 const linkUrl = sanitizeString(data.click?.link || data.link || data.url);
 const linkLabel = sanitizeString(data.link_label || data.click?.link_label);
 const sectionId = sanitizeString(data.section_id || data.click?.section_id);
 const occurredAt = sanitizeString(data.created_at) || new Date().toISOString();

 // ── Route job-alert emails to job_alert_subscribers/{email} ──
 if (emailType === 'job-alert' || emailType === 'job-alert-retry') {
 const alertId = sanitizeString(tags.alert_id) || uniqueUnknownFallback(messageId, occurredAt);
 await applyJobAlertEvent(db, { email, type, alertId, messageId, linkUrl, linkLabel, occurredAt, rawEvent });
 return { handled: true, email, type, collection: 'job_alert_subscribers', alertId };
 }

 // ── Newsletter events (existing behavior) ────────────────────
 const campaignId = sanitizeString(tags.campaign_id || data.campaign_id) || uniqueUnknownFallback(messageId, occurredAt);
 const variant = sanitizeString(tags.variant || data.variant) || 'general';
 const locale = sanitizeString(tags.subscriber_locale || data.locale) || 'it-IT';
 const sourceChannel = sanitizeString(tags.source_channel || data.source_channel);

 // Bounce severity depends only on the raw provider payload, not on the
 // current subscriber doc, so it can be computed outside the transaction.
 let bounceSeverity = null;
 let bounceReasonText = '';
 if (type === 'bounce') {
 bounceSeverity = classifyBounceSeverity({ provider: 'resend', rawEvent: rawEvent?.type, eventData: data });
 bounceReasonText = sanitizeString(data.bounce?.message) || sanitizeString(data.reason) || '';
 }

 // Read current subscriber status and write the merged update atomically —
 // wrapped in a transaction (same idiom as maybeEscalateSoftBounce /
 // refreshEngagementScore in functions/src/lib/) so a concurrent webhook
 // delivery for the same subscriber (e.g. a complaint/suppression landing
 // between this read and this write) can't be clobbered by a promotion
 // decision made from a stale read.
 const subscriberRef = db.collection('newsletter_subscribers').doc(email);
 await subscriberRef.firestore.runTransaction(async (tx) => {
 // Read current subscriber status to avoid promoting pending users, plus
 // `bounce_severity` — the suppression-recovery decision below needs both
 // (a 'bounced' doc is recoverable only when the bounce was NOT hard) — plus
 // the whole document, because the opt-out stamp that outranks `status`
 // lives in fields no projection was carrying (#5741). `.data()` is called
 // once and kept: the recovery decision must see the DATA, never the
 // snapshot, which reads `undefined` for every field it asks about.
 let currentData = null;
 let currentStatus = null;
 let currentBounceSeverity = null;
 try {
 const subscriberDoc = await tx.get(subscriberRef);
 if (subscriberDoc.exists) {
 currentData = subscriberDoc.data() || null;
 currentStatus = currentData?.status || null;
 currentBounceSeverity = currentData?.bounce_severity || null;
 }
 } catch {
 // If read fails, proceed without status — safe default
 }

 const subscriberUpdate = buildSubscriberUpdate(type, {
 email,
 link_url: linkUrl,
 target_url: linkUrl,
 section_id: sectionId,
 }, currentStatus);

 subscriberUpdate.provider = 'resend';

 // Suppression recovery — one decision point for all 5 providers, both
 // branches (functions/src/lib/subscriberReactivation.js). A delivered/open/
 // click proves the mailbox is alive, so it clears a MACHINE-inferred
 // suppression: our own 'inactive' sunset (#2852 item 2), a provider
 // 'suppressed', or a 'bounced' that is NOT proven-permanent. It never
 // clears a human-declared 'complained'/'unsubscribed', nor a hard bounce.
 // Applied AFTER buildSubscriberUpdate() on purpose: that function's
 // pending-promotion side effect would otherwise leave a recovered
 // subscriber at status 'confirmed' without stamping the audit trail, and
 // its NON_PROMOTABLE_STATUSES guard (#3305) refuses to blanket-promote a
 // suppressed subscriber at all — deliberately, since it cannot tell a
 // recoverable suppression from a permanent one. This can.
 if (type === 'delivered' || type === 'open' || type === 'click') {
 Object.assign(subscriberUpdate, positiveEventRecoveryFields({
 subscriber: currentData,
 currentStatus,
 bounceSeverity: currentBounceSeverity,
 event: type,
 }));
 }

 if (type === 'bounce') {
 Object.assign(subscriberUpdate, bounceUpdateFields({ severity: bounceSeverity, reason: bounceReasonText }));
 if (bounceSeverity === 'hard') {
 subscriberUpdate.isActive = false;
 subscriberUpdate.active = false;
 }
 }

 tx.set(subscriberRef, subscriberUpdate, { merge: true });
 });

 if (bounceSeverity === 'soft') {
 await maybeEscalateSoftBounce(subscriberRef, bounceReasonText);
 }

 // Update engagement score after metrics change (FRO-17)
 if (type === 'open' || type === 'click' || type === 'send') {
 await refreshEngagementScore(
 db.collection('newsletter_subscribers').doc(email),
 admin.firestore.FieldValue,
 );
 }

 await db.collection('newsletter_subscribers').doc(email).collection('campaign_deliveries').doc(buildDeliveryDocId(email, campaignId)).set({
 email,
 provider: 'resend',
 campaign_id: campaignId,
 message_id: messageId,
 variant,
 locale,
 source_channel: sourceChannel,
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 ...(type === 'send' ? { sent_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'delivered' ? { delivered_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'open' ? { opened_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'click'
 ? {
 clicked_at: admin.firestore.FieldValue.serverTimestamp(),
 last_clicked_url: linkUrl,
 last_clicked_label: linkLabel,
 last_clicked_section: sectionId,
 clicked_links: admin.firestore.FieldValue.increment(1),
 }
 : {}),
 ...(type === 'bounce' ? { bounced_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'complaint' ? { complained_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'suppressed' ? { suppressed_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'failed' ? { failed_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'delivery_delayed' ? { delayed_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 ...(type === 'scheduled' ? { scheduled_at: admin.firestore.FieldValue.serverTimestamp() } : {}),
 }, { merge: true });

 await db.collection('newsletter_subscribers').doc(email).collection('events').add({
 email,
 provider: 'resend',
 event_type: type,
 campaign_id: campaignId,
 message_id: messageId,
 variant,
 section_id: sectionId,
 source_locale: locale,
 source_channel: sourceChannel,
 link_url: linkUrl,
 link_label: linkLabel,
 target_url: linkUrl,
 metadata: rawEvent,
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: occurredAt,
 });

 // Refresh preferred send hour (#3798) — only open/click carry a time-of-day
 // signal. Runs AFTER the events.add() above so the just-arrived event is
 // itself part of the sample the recompute reads back (otherwise the
 // computation always lags one event behind, and the cold-start threshold
 // would only ever be cleared on the event *after* the 3rd one).
 if (type === 'open' || type === 'click') {
 await refreshPreferredSendHour(
 db.collection('newsletter_subscribers').doc(email),
 admin.firestore.FieldValue,
 );
 }

 if (type === 'open') {
 const { isOperatorVerification } = await lookupSentVariant(subscriberRef, campaignId, email);
 if (!isOperatorVerification) {
 await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.OPENED, { email, provider: 'resend', campaignId, variant, locale });
 }
 }
 return { handled: true, email, type, campaignId };
}

/**
 * Apply a delivery event to job_alert_subscribers/{email}.
 * Mirrors newsletter_subscribers pattern: top-level doc with counters,
 * alert_deliveries/{alertId} subcollection, events/{auto-id} subcollection.
 */
async function applyJobAlertEvent(db, { email, type, alertId, messageId, linkUrl, linkLabel, occurredAt, rawEvent }) {
 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('job_alert_subscribers').doc(email);
 const data = rawEvent?.data || {};

 // ── Top-level subscriber document (aggregate counters) ──────
 const topUpdate = {
 email,
 updated_at: FieldValue.serverTimestamp(),
 };
 let bounceSeverity = null;
 let bounceReasonText = '';
 if (type === 'send') {
 topUpdate.last_sent_at = FieldValue.serverTimestamp();
 topUpdate.send_count = FieldValue.increment(1);
 }
 if (type === 'delivered') {
 topUpdate.last_delivered_at = FieldValue.serverTimestamp();
 topUpdate.delivered_count = FieldValue.increment(1);
 Object.assign(topUpdate, softBounceRecoveryFields());
 }
 if (type === 'open') {
 topUpdate.last_open_at = FieldValue.serverTimestamp();
 topUpdate.open_count = FieldValue.increment(1);
 Object.assign(topUpdate, softBounceRecoveryFields());
 }
 if (type === 'click') {
 topUpdate.last_click_at = FieldValue.serverTimestamp();
 topUpdate.click_count = FieldValue.increment(1);
 topUpdate.last_clicked_url = linkUrl;
 Object.assign(topUpdate, softBounceRecoveryFields());
 }
 if (type === 'bounce') {
 bounceSeverity = classifyBounceSeverity({ provider: 'resend', rawEvent: rawEvent?.type, eventData: data });
 bounceReasonText = sanitizeString(data.bounce?.message) || sanitizeString(data.reason) || '';
 topUpdate.last_bounced_at = FieldValue.serverTimestamp();
 topUpdate.bounce_count = FieldValue.increment(1);
 Object.assign(topUpdate, bounceUpdateFields({ severity: bounceSeverity, reason: bounceReasonText }));
 }
 if (type === 'complaint') {
 topUpdate.last_complained_at = FieldValue.serverTimestamp();
 topUpdate.status = 'complained';
 }
 if (type === 'failed') {
 topUpdate.last_failed_at = FieldValue.serverTimestamp();
 topUpdate.fail_count = FieldValue.increment(1);
 }
 // Healthy delivery events → recover a machine-inferred suppression, or (for a
 // doc that is not suppressed at all) keep the historical "healthy → active"
 // promotion. This used to be an UNCONDITIONAL `topUpdate.status = 'active'`,
 // which would overwrite 'complained' — a human's spam complaint — with a
 // machine's inference, and equally resurrect a proven-permanent hard bounce.
 if (type === 'delivered' || type === 'open' || type === 'click') {
 const current = (await subscriberRef.get()).data() || {};
 Object.assign(topUpdate, positiveEventStatusFields({
 subscriber: current,
 currentStatus: current.status,
 bounceSeverity: current.bounce_severity,
 event: type,
 }));
 }

 await subscriberRef.set(topUpdate, { merge: true });

 if (bounceSeverity === 'soft') {
 await maybeEscalateSoftBounce(subscriberRef, bounceReasonText);
 }

 // ── Engagement score ────────────────────────────────────────
 if (type === 'open' || type === 'click' || type === 'send') {
 await refreshEngagementScore(subscriberRef, FieldValue);
 }

 // ── Per-alert delivery record (subcollection) ───────────────
 await subscriberRef.collection('alert_deliveries').doc(alertId).set({
 alert_id: alertId,
 message_id: messageId,
 updated_at: FieldValue.serverTimestamp(),
 ...(type === 'send' ? { sent_at: FieldValue.serverTimestamp() } : {}),
 ...(type === 'delivered' ? { delivered_at: FieldValue.serverTimestamp() } : {}),
 ...(type === 'open' ? { opened_at: FieldValue.serverTimestamp() } : {}),
 ...(type === 'click'
 ? {
 clicked_at: FieldValue.serverTimestamp(),
 last_clicked_url: linkUrl,
 last_clicked_label: linkLabel,
 clicked_links: FieldValue.increment(1),
 }
 : {}),
 ...(type === 'bounce' ? { bounced_at: FieldValue.serverTimestamp() } : {}),
 ...(type === 'failed' ? { failed_at: FieldValue.serverTimestamp() } : {}),
 }, { merge: true });

 // ── Raw event log (subcollection) ───────────────────────────
 // `provider` is NOT optional here even though this branch only ever runs for
 // Resend: the other four job-alert webhooks all stamp it, and any report that
 // groups engagement by provider reads this field. Its absence (until
 // 2026-08-20) made every Resend job-alert event provider-less, so a
 // collectionGroup('events') roll-up had to guess the provider from the parent
 // collection instead of reading it.
 await subscriberRef.collection('events').add({
 email,
 provider: 'resend',
 event_type: type,
 alert_id: alertId,
 message_id: messageId,
 link_url: linkUrl,
 link_label: linkLabel,
 metadata: rawEvent,
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: occurredAt,
 });

 // ── Preferred send hour (#3798) ──────────────────────────────
 // job_alert_subscribers/{email} has the same events subcollection shape as
 // newsletter_subscribers. Only open/click carry a time-of-day signal. Runs
 // AFTER the events.add() above so the current event is part of the sample
 // it reads.
 if (type === 'open' || type === 'click') {
 await refreshPreferredSendHour(subscriberRef, FieldValue);
 }
}

export async function handleResendWebhookRequest({ payload, headers, webhookSecret }) {
 const verifiedEvent = verifyResendWebhookSignature({ payload, headers, webhookSecret });
 return applyResendWebhookEvent(verifiedEvent);
}
