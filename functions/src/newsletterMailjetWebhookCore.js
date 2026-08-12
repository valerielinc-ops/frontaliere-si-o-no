import admin from 'firebase-admin';
import { refreshEngagementScore } from './lib/engagementScore.js';
import { refreshPreferredSendHour } from './lib/preferredSendHour.js';
import { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS, lookupSentVariant } from './lib/emailExperimentPostHog.js';
import { classifyBounceSeverity, bounceUpdateFields, softBounceRecoveryFields, maybeEscalateSoftBounce } from './lib/bounceClassification.js';
import { positiveEventRecoveryFields, positiveEventStatusFields } from './lib/subscriberReactivation.js';
import { normalizeEmailAddress } from './lib/parseEmailField.js';
import { uniqueUnknownFallback } from './lib/deliveryDocId.js';

/**
 * Mailjet webhook handler — receives delivery events and stores them in Firestore.
 *
 * Mailjet sends events as a JSON array (batched). Each element has:
 * event, time, email, MessageID, Message_GUID, mj_campaign_id,
 * mj_contact_id, CustomID, Payload, ip, geo, agent, url (click), etc.
 *
 * Event types: sent, open, click, bounce, blocked, spam, unsub
 *
 * Mailjet does NOT sign webhooks with HMAC. Security is via a shared secret
 * token passed as a query parameter in the webhook URL configured on Mailjet.
 * URL format: https://{function-url}?secret={MAILJET_WEBHOOK_SECRET}
 *
 * Firestore paths (same as Resend/Mailgun webhooks):
 * newsletter_subscribers/{email}/events/{auto-id}
 * newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 * newsletter_subscribers/{email} (status updates: bounced, unsubscribed, etc.)
 */

// ── Event type mapping (Mailjet → our normalized types) ──────

function mapMailjetEvent(event) {
 switch (String(event || '').toLowerCase()) {
 case 'sent': return 'send';
 case 'open': return 'open';
 case 'click': return 'click';
 case 'bounce': return 'bounce';
 case 'blocked': return 'bounce';
 case 'spam': return 'complaint';
 case 'unsub': return 'unsubscribed';
 default: return null;
 }
}

// ── Extract campaign ID from Mailjet event data ──────────────

function extractCampaignId(eventData) {
 // CustomID is set by our email-cascade (campaignIdTag → the `weekly_*` id) when
 // sending via the Mailjet Send API, and Mailjet echoes it back on every event
 // (incl. open/click). Preferring it here is what makes Mailjet open events
 // match the A/B report's `events where campaign_id == weekly_*` query — keep it
 // FIRST so opens are never bucketed under Mailjet's internal numeric id.
 if (eventData.CustomID) return String(eventData.CustomID);
 // customcampaign is Mailjet's own campaign name field
 if (eventData.customcampaign) return String(eventData.customcampaign);
 // mj_campaign_id is Mailjet's internal numeric campaign id (last-resort fallback
 // only — the A/B report cannot match opens carrying this instead of weekly_*).
 if (eventData.mj_campaign_id) return String(eventData.mj_campaign_id);
 // No tag survived — key the fallback on the per-event messageId instead of
 // the shared literal 'unknown', so two distinct untagged sends to the same
 // recipient don't collapse onto the same campaign_deliveries/events doc
 // (#4847 class fix, see functions/src/newsletterResendWebhookCore.js).
 return uniqueUnknownFallback(extractMessageId(eventData), eventData.time ? String(eventData.time) : null);
}

function extractMessageId(eventData) {
 return String(eventData.Message_GUID || eventData.MessageID || '');
}

// ── Persist a single Mailjet event to Firestore ──────────────

export async function persistMailjetEvent(db, eventData) {
 const email = normalizeEmailAddress(eventData.email);
 if (!email || !email.includes('@')) return { skipped: true, reason: 'invalid_email' };

 const mjEvent = eventData.event;
 const type = mapMailjetEvent(mjEvent);
 if (!type) return { skipped: true, reason: `unknown_event: ${mjEvent}` };

 const campaignId = extractCampaignId(eventData);
 const messageId = extractMessageId(eventData);
 const timestamp = eventData.time
 ? new Date(eventData.time * 1000).toISOString()
 : new Date().toISOString();

 // Route job-alert events to job_alert_subscribers/{email}
 const customId = eventData.CustomID || eventData.custom_id || '';
 if (customId === 'job-alert' || customId === 'job-alert-retry') {
 return persistJobAlertMailjetEvent(db, { email, type, mjEvent, messageId, timestamp, eventData });
 }

 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('newsletter_subscribers').doc(email);

 // Update subscriber-level fields (aligned with Resend/Mailgun handlers)
 const subscriberUpdate = {
 updated_at: FieldValue.serverTimestamp(),
 };

 let bounceSeverity = null;
 let bounceReasonText = '';

 if (type === 'send') {
 subscriberUpdate.last_sent_at = FieldValue.serverTimestamp();
 subscriberUpdate.send_count = FieldValue.increment(1);
 } else if (type === 'open') {
 subscriberUpdate.last_open_at = FieldValue.serverTimestamp();
 subscriberUpdate.open_count = FieldValue.increment(1);
 Object.assign(subscriberUpdate, softBounceRecoveryFields());
 } else if (type === 'click') {
 subscriberUpdate.last_click_at = FieldValue.serverTimestamp();
 subscriberUpdate.click_count = FieldValue.increment(1);
 subscriberUpdate.last_clicked_url = eventData.url || '';
 Object.assign(subscriberUpdate, softBounceRecoveryFields());
 } else if (type === 'bounce') {
 bounceSeverity = classifyBounceSeverity({ provider: 'mailjet', rawEvent: mjEvent, eventData });
 bounceReasonText = eventData.error || '';
 subscriberUpdate.bounce_hard = !!eventData.hard_bounce;
 Object.assign(subscriberUpdate, bounceUpdateFields({ severity: bounceSeverity, reason: bounceReasonText }));
 } else if (type === 'unsubscribed') {
 subscriberUpdate.status = 'unsubscribed';
 subscriberUpdate.unsubscribed_at = FieldValue.serverTimestamp();
 // Both spellings, and the mailable flags, so a provider-reported opt-out
 // leaves the SAME observable state as the one-click function and the SPA
 // link (#5673). Setting `status` alone — as this branch did, unlike the
 // `suppressed` branch three lines below — is how a document ends up
 // `unsubscribed` yet still `isActive: true`: 281 of them, measured
 // 2026-08-12.
 subscriberUpdate.unsubscribedAt = FieldValue.serverTimestamp();
 subscriberUpdate.isActive = false;
 subscriberUpdate.active = false;
 } else if (type === 'complaint') {
 subscriberUpdate.status = 'complained';
 subscriberUpdate.complained_at = FieldValue.serverTimestamp();
 }

 // Suppression recovery — one decision point for all 5 providers, both
 // branches (functions/src/lib/subscriberReactivation.js). A delivered/open/
 // click proves the mailbox is alive, so it clears a MACHINE-inferred
 // suppression: our own 'inactive' sunset (#2852 item 2), a provider
 // 'suppressed', or a 'bounced' that is NOT proven-permanent. It never
 // clears a human-declared 'complained'/'unsubscribed', nor a hard bounce.
 // The doc read happens only on these three event types. ('delivered' is
 // unreachable for Mailjet — mapMailjetEvent has no such mapping — but the
 // guard is kept identical across the 5 providers so the class cannot drift.)
 if (type === 'delivered' || type === 'open' || type === 'click') {
 const current = (await subscriberRef.get()).data() || {};
 Object.assign(subscriberUpdate, positiveEventRecoveryFields({
 currentStatus: current.status,
 bounceSeverity: current.bounce_severity,
 event: type,
 }));
 }

 if (Object.keys(subscriberUpdate).length > 1) {
 await subscriberRef.set(subscriberUpdate, { merge: true });
 }

 if (bounceSeverity === 'soft') {
 await maybeEscalateSoftBounce(subscriberRef, bounceReasonText);
 }

 // Refresh engagement score after counter changes (FRO-17)
 if (type === 'open' || type === 'click' || type === 'send') {
 await refreshEngagementScore(subscriberRef, FieldValue);
 }

 // Update campaign delivery doc
 const deliveryData = {
 email,
 campaign_id: campaignId,
 message_id: messageId,
 provider: 'mailjet',
 updated_at: admin.firestore.FieldValue.serverTimestamp(),
 };

 if (type === 'send') deliveryData.sent_at = admin.firestore.FieldValue.serverTimestamp();
 if (type === 'delivered') deliveryData.delivered_at = admin.firestore.FieldValue.serverTimestamp();
 if (type === 'open') deliveryData.opened_at = admin.firestore.FieldValue.serverTimestamp();
 if (type === 'bounce') deliveryData.bounced_at = admin.firestore.FieldValue.serverTimestamp();
 if (type === 'complaint') deliveryData.complained_at = admin.firestore.FieldValue.serverTimestamp();
 if (type === 'click') {
 deliveryData.clicked_at = admin.firestore.FieldValue.serverTimestamp();
 deliveryData.last_clicked_url = eventData.url || '';
 deliveryData.clicked_links = admin.firestore.FieldValue.increment(1);
 }

 const deliveryDocId = `${campaignId}_${email}`.replace(/[/\\]/g, '_').slice(0, 200);
 await subscriberRef.collection('campaign_deliveries').doc(deliveryDocId).set(deliveryData, { merge: true });

 // Append to events log
 await subscriberRef.collection('events').add({
 email,
 event_type: type,
 mailjet_event: mjEvent,
 campaign_id: campaignId,
 message_id: messageId,
 provider: 'mailjet',
 metadata: {
 mj_campaign_id: eventData.mj_campaign_id || null,
 mj_contact_id: eventData.mj_contact_id || null,
 custom_id: eventData.CustomID || null,
 payload: eventData.Payload || null,
 ip: eventData.ip || null,
 geo: eventData.geo || null,
 agent: eventData.agent || null,
 url: eventData.url || null,
 // bounce-specific
 blocked: eventData.blocked ?? null,
 hard_bounce: eventData.hard_bounce ?? null,
 error_related_to: eventData.error_related_to || null,
 error: eventData.error || null,
 // spam-specific
 source: eventData.source || null,
 },
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: timestamp,
 });

 // Refresh preferred send hour (#3798) — only open/click carry a time-of-day
 // signal. Runs AFTER the events.add() above so the just-arrived event is
 // itself part of the sample the recompute reads back (otherwise the
 // computation always lags one event behind, and the cold-start threshold
 // would only ever be cleared on the event *after* the 3rd one).
 if (type === 'open' || type === 'click') {
 await refreshPreferredSendHour(subscriberRef, FieldValue);
 }

 if (type === 'open') {
 const { variant, isOperatorVerification } = await lookupSentVariant(subscriberRef, campaignId, email);
 if (!isOperatorVerification) {
 await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.OPENED, { email, provider: 'mailjet', campaignId, variant });
 }
 }
 return { processed: true, type, email, campaignId };
}

// ── Job alert event handler (mirrors newsletter pattern) ────

async function persistJobAlertMailjetEvent(db, { email, type, mjEvent, messageId, timestamp, eventData }) {
 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('job_alert_subscribers').doc(email);

 const topUpdate = { email, updated_at: FieldValue.serverTimestamp() };
 let bounceSeverity = null;
 let bounceReasonText = '';
 if (type === 'delivered') { topUpdate.last_delivered_at = FieldValue.serverTimestamp(); topUpdate.delivered_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'open') { topUpdate.last_open_at = FieldValue.serverTimestamp(); topUpdate.open_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'click') { topUpdate.last_click_at = FieldValue.serverTimestamp(); topUpdate.click_count = FieldValue.increment(1); topUpdate.last_clicked_url = eventData.url || ''; Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'bounce') {
 bounceSeverity = classifyBounceSeverity({ provider: 'mailjet', rawEvent: mjEvent, eventData });
 bounceReasonText = eventData.error || mjEvent || '';
 topUpdate.last_bounced_at = FieldValue.serverTimestamp();
 topUpdate.bounce_count = FieldValue.increment(1);
 Object.assign(topUpdate, bounceUpdateFields({ severity: bounceSeverity, reason: bounceReasonText }));
 }
 if (type === 'complaint') { topUpdate.status = 'complained'; topUpdate.last_complained_at = FieldValue.serverTimestamp(); }
 // Healthy delivery events → recover a machine-inferred suppression, or (for a
 // doc that is not suppressed at all) keep the historical "healthy → active"
 // promotion. This used to be an UNCONDITIONAL `topUpdate.status = 'active'`,
 // which would overwrite 'complained' — a human's spam complaint — with a
 // machine's inference, and equally resurrect a proven-permanent hard bounce.
 if (type === 'delivered' || type === 'open' || type === 'click') {
 const current = (await subscriberRef.get()).data() || {};
 Object.assign(topUpdate, positiveEventStatusFields({
 currentStatus: current.status,
 bounceSeverity: current.bounce_severity,
 event: type,
 }));
 }

 await subscriberRef.set(topUpdate, { merge: true });

 if (bounceSeverity === 'soft') {
 await maybeEscalateSoftBounce(subscriberRef, bounceReasonText);
 }

 await subscriberRef.collection('events').add({
 email,
 event_type: type,
 mailjet_event: mjEvent,
 message_id: messageId,
 provider: 'mailjet',
 metadata: {
 custom_id: eventData.CustomID || null,
 url: eventData.url || null,
 },
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: timestamp,
 });

 // Refresh preferred send hour (#3798) — job_alert_subscribers/{email} has the
 // same events subcollection shape as newsletter_subscribers. Runs AFTER the
 // events.add() above so the current event is part of the sample it reads.
 if (type === 'open' || type === 'click') {
 await refreshPreferredSendHour(subscriberRef, FieldValue);
 }

 return { processed: true, type, email, collection: 'job_alert_subscribers' };
}

// ── Request handler ──────────────────────────────────────────

export async function handleMailjetWebhookRequest({ body, query, webhookSecret, db: injectedDb }) {
 // Verify shared secret token from query parameter
 if (webhookSecret) {
 const providedSecret = query?.secret || '';
 if (!providedSecret || providedSecret !== webhookSecret) {
 throw new Error('Invalid Mailjet webhook secret');
 }
 }

 // Mailjet sends events as a JSON array
 const events = Array.isArray(body) ? body : [body];

 if (events.length === 0) {
 return { processed: 0, results: [] };
 }

 const db = injectedDb || admin.firestore();
 const results = [];

 for (const eventData of events) {
 try {
 const result = await persistMailjetEvent(db, eventData);
 results.push(result);
 console.log(`[mailjetWebhook] ${eventData.event} → ${result.type || 'skipped'} for ${eventData.email || '?'}`);
 } catch (err) {
 console.error(`[mailjetWebhook] Error processing event: ${err.message}`);
 results.push({ skipped: true, reason: err.message });
 }
 }

 const processedCount = results.filter(r => r.processed).length;
 return { processed: processedCount, total: events.length, results };
}
