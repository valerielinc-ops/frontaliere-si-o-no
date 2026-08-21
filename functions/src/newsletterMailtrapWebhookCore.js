import admin from 'firebase-admin';
import { refreshEngagementScore } from './lib/engagementScore.js';
import { refreshPreferredSendHour } from './lib/preferredSendHour.js';
import { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS } from './lib/emailExperimentPostHog.js';
import { classifyBounceSeverity, bounceUpdateFields, softBounceRecoveryFields, maybeEscalateSoftBounce } from './lib/bounceClassification.js';
import { positiveEventRecoveryFields, positiveEventStatusFields } from './lib/subscriberReactivation.js';
import { normalizeEmailAddress } from './lib/parseEmailField.js';

/**
 * Mailtrap webhook handler — receives delivery events and stores them in Firestore.
 *
 * Mailtrap sends batched events as { events: [...] }.
 * Auth: shared secret passed as ?secret= query parameter (same pattern as Mailjet).
 *
 * Events: delivery, bounce, soft_bounce, open, click, unsubscribe,
 * spam_complaint, reject, suspension.
 *
 * Firestore paths (same as other provider webhooks):
 * newsletter_subscribers/{email}/events/{auto-id}
 * newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 * newsletter_subscribers/{email} (status updates: bounced, unsubscribed, etc.)
 */

// ── Event type mapping (Mailtrap → normalized types) ────────

function mapMailtrapEvent(event) {
 switch (String(event || '').toLowerCase()) {
 case 'delivery': return 'delivered';
 case 'open': return 'open';
 case 'click': return 'click';
 case 'bounce': return 'bounce';
 case 'soft_bounce': return 'bounce';
 case 'reject': return 'bounce';
 case 'unsubscribe': return 'unsubscribed';
 case 'spam_complaint': return 'complaint';
 // `suspension` is an ACCOUNT/STREAM-level signal from Mailtrap — it means
 // Mailtrap stopped sending, not that this recipient is undeliverable. Its
 // payload carries no bounce_category, no response and no response_code,
 // precisely because there was no recipient-side failure to report. Mapping
 // it to 'suppressed' burned over 1700 subscribers, more than a fifth of the base, who had
 // never bounced or complained, including ones with opens and deliveries
 // minutes earlier. Left unmapped on purpose, which makes handleMailtrapWebhook
 // return { skipped: true } without recording anything — acceptable because
 // mailtrap is no longer in the send cascade, so no new suspensions can arrive
 // for messages we sent. What matters is that it never changes a status again.
 case 'suspension': return null;
 default: return null;
 }
}

// ── Extract campaign ID from Mailtrap event ─────────────────

function extractCampaignId(data) {
 const vars = data.custom_variables || {};
 if (vars.campaign) return String(vars.campaign);
 if (vars.campaign_id) return String(vars.campaign_id);
 // `category` is what the cascade actually sets for this provider
 // (sendViaMailtrap: `body.category = campaignIdTag(email)`), and Mailtrap
 // echoes it back on every event — the two halves had simply never been
 // connected, so the campaign fell through to the message id here exactly as
 // it did on Mailgun and Maileroo (same defect class, found 2026-08-20).
 // Field name verified against Mailtrap's official webhook payload docs
 // (docs.mailtrap.io/email-api-smtp/advanced/webhooks): `category` is a
 // top-level, optional string on every sending-stream event — not nested
 // under a namespaced object — confirming the flat `data.category` read
 // below is correct as written, not an assumption (2026-08-21).
 if (data.category) return String(data.category);
 return data.message_id || 'unknown';
}

// ── Persist a single event to Firestore ─────────────────────

export async function persistMailtrapEvent(db, eventData) {
 const email = normalizeEmailAddress(eventData.email);
 if (!email || !email.includes('@')) return { skipped: true, reason: 'invalid_email' };

 const type = mapMailtrapEvent(eventData.event);
 if (!type) return { skipped: true, reason: `unknown_event: ${eventData.event}` };

 const campaignId = extractCampaignId(eventData);
 const messageId = eventData.message_id || '';
 const occurredAt = eventData.timestamp
 ? new Date(eventData.timestamp * 1000).toISOString()
 : new Date().toISOString();

 // Route job-alert events to job_alert_subscribers
 const vars = eventData.custom_variables || {};
 const category = eventData.category || '';
 const isJobAlert = vars.type === 'job-alert' || vars.type === 'job-alert-retry'
 || category === 'job-alert' || category === 'job-alert-retry';
 if (isJobAlert) {
 return persistJobAlertMailtrapEvent(db, { email, type, eventData, messageId, occurredAt });
 }

 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('newsletter_subscribers').doc(email);

 // Update subscriber-level fields
 const subscriberUpdate = {
 updated_at: FieldValue.serverTimestamp(),
 };

 let bounceSeverity = null;
 let bounceReasonText = '';

 if (type === 'delivered') {
 subscriberUpdate.last_delivered_at = FieldValue.serverTimestamp();
 Object.assign(subscriberUpdate, softBounceRecoveryFields());
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
 bounceSeverity = classifyBounceSeverity({ provider: 'mailtrap', rawEvent: eventData.event, eventData });
 bounceReasonText = eventData.bounce_category || eventData.event || '';
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
 } else if (type === 'suppressed') {
 subscriberUpdate.status = 'suppressed';
 subscriberUpdate.suppressed_at = FieldValue.serverTimestamp();
 subscriberUpdate.isActive = false;
 subscriberUpdate.active = false;
 }

 // Suppression recovery — one decision point for all 5 providers, both
 // branches (functions/src/lib/subscriberReactivation.js). A delivered/open/
 // click proves the mailbox is alive, so it clears a MACHINE-inferred
 // suppression: our own 'inactive' sunset (#2852 item 2), a provider
 // 'suppressed', or a 'bounced' that is NOT proven-permanent. It never
 // clears a human-declared 'complained'/'unsubscribed', nor a hard bounce.
 // The doc read happens only on these three event types.
 if (type === 'delivered' || type === 'open' || type === 'click') {
 const current = (await subscriberRef.get()).data() || {};
 Object.assign(subscriberUpdate, positiveEventRecoveryFields({
 subscriber: current,
 currentStatus: current.status,
 bounceSeverity: current.bounce_severity,
 event: type,
 }));
 }

 await subscriberRef.set(subscriberUpdate, { merge: true });

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
 provider: 'mailtrap',
 updated_at: FieldValue.serverTimestamp(),
 };

 if (type === 'delivered') deliveryData.delivered_at = FieldValue.serverTimestamp();
 if (type === 'open') deliveryData.opened_at = FieldValue.serverTimestamp();
 if (type === 'bounce') deliveryData.bounced_at = FieldValue.serverTimestamp();
 if (type === 'complaint') deliveryData.complained_at = FieldValue.serverTimestamp();
 if (type === 'suppressed') deliveryData.suppressed_at = FieldValue.serverTimestamp();
 if (type === 'click') {
 deliveryData.clicked_at = FieldValue.serverTimestamp();
 deliveryData.last_clicked_url = eventData.url || '';
 deliveryData.clicked_links = FieldValue.increment(1);
 }

 const deliveryDocId = `${campaignId}_${email}`.replace(/[/\\]/g, '_').slice(0, 200);
 await subscriberRef.collection('campaign_deliveries').doc(deliveryDocId).set(deliveryData, { merge: true });

 // Append to events log
 await subscriberRef.collection('events').add({
 email,
 event_type: type,
 mailtrap_event: eventData.event,
 campaign_id: campaignId,
 message_id: messageId,
 provider: 'mailtrap',
 metadata: {
 category: eventData.category || null,
 event_id: eventData.event_id || null,
 bounce_category: eventData.bounce_category || null,
 response: eventData.response || null,
 response_code: eventData.response_code || null,
 url: eventData.url || null,
 ip: eventData.ip || null,
 user_agent: eventData.user_agent || null,
 sending_stream: eventData.sending_stream || null,
 custom_variables: eventData.custom_variables || null,
 },
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: occurredAt,
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
 await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.OPENED, { email, provider: 'mailtrap', campaignId });
 }
 return { processed: true, type, email, campaignId };
}

// ── Job alert event handler (mirrors newsletter pattern) ────

async function persistJobAlertMailtrapEvent(db, { email, type, eventData, messageId, occurredAt }) {
 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('job_alert_subscribers').doc(email);

 const topUpdate = { email, updated_at: FieldValue.serverTimestamp() };
 let bounceSeverity = null;
 let bounceReasonText = '';
 if (type === 'delivered') { topUpdate.last_delivered_at = FieldValue.serverTimestamp(); topUpdate.delivered_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'open') { topUpdate.last_open_at = FieldValue.serverTimestamp(); topUpdate.open_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'click') { topUpdate.last_click_at = FieldValue.serverTimestamp(); topUpdate.click_count = FieldValue.increment(1); topUpdate.last_clicked_url = eventData.url || ''; Object.assign(topUpdate, softBounceRecoveryFields()); }
 if (type === 'bounce') {
 bounceSeverity = classifyBounceSeverity({ provider: 'mailtrap', rawEvent: eventData.event, eventData });
 bounceReasonText = eventData.bounce_category || eventData.event || '';
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

 await subscriberRef.collection('events').add({
 email,
 event_type: type,
 mailtrap_event: eventData.event,
 message_id: messageId,
 provider: 'mailtrap',
 metadata: {
 url: eventData.url || null,
 category: eventData.category || null,
 custom_variables: eventData.custom_variables || null,
 },
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: occurredAt,
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

export async function handleMailtrapWebhookRequest({ body, query, webhookSecret }) {
 // Verify shared secret (query parameter)
 if (webhookSecret) {
 const providedSecret = query?.secret;
 if (!providedSecret || providedSecret !== webhookSecret) {
 console.warn('[mailtrapWebhook] Secret mismatch or missing');
 throw new Error('Invalid webhook secret');
 }
 }

 console.log(`[mailtrapWebhook] Body preview: ${JSON.stringify(body).slice(0, 300)}`);

 const events = body?.events;
 if (!Array.isArray(events) || events.length === 0) {
 console.log('[mailtrapWebhook] No events in payload (ping or empty batch)');
 return { ok: true, ping: true };
 }

 const db = admin.firestore();
 const results = [];

 for (const event of events) {
 try {
 const result = await persistMailtrapEvent(db, event);
 results.push(result);
 console.log(`[mailtrapWebhook] ${event.event} → ${result.type || 'skipped'} for ${event.email || '?'}`);
 } catch (err) {
 console.error(`[mailtrapWebhook] Error processing ${event.event} for ${event.email}: ${err.message}`);
 results.push({ error: err.message, event: event.event, email: event.email });
 }
 }

 return { processed: results.length, results };
}
