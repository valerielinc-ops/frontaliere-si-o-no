import admin from 'firebase-admin';

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

function normalizeEmail(value) {
 return String(value || '').trim().toLowerCase();
}

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
 case 'suspension': return 'suppressed';
 default: return null;
 }
}

// ── Extract campaign ID from Mailtrap event ─────────────────

function extractCampaignId(data) {
 const vars = data.custom_variables || {};
 if (vars.campaign) return String(vars.campaign);
 if (vars.campaign_id) return String(vars.campaign_id);
 return data.message_id || 'unknown';
}

// ── Persist a single event to Firestore ─────────────────────

async function persistMailtrapEvent(db, eventData) {
 const email = normalizeEmail(eventData.email);
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

 if (type === 'delivered') {
 subscriberUpdate.last_delivered_at = FieldValue.serverTimestamp();
 } else if (type === 'open') {
 subscriberUpdate.last_open_at = FieldValue.serverTimestamp();
 subscriberUpdate.open_count = FieldValue.increment(1);
 } else if (type === 'click') {
 subscriberUpdate.last_click_at = FieldValue.serverTimestamp();
 subscriberUpdate.click_count = FieldValue.increment(1);
 subscriberUpdate.last_clicked_url = eventData.url || '';
 } else if (type === 'bounce') {
 subscriberUpdate.status = 'bounced';
 subscriberUpdate.bounced_at = FieldValue.serverTimestamp();
 subscriberUpdate.bounce_reason = eventData.bounce_category || eventData.event || '';
 } else if (type === 'unsubscribed') {
 subscriberUpdate.status = 'unsubscribed';
 subscriberUpdate.unsubscribed_at = FieldValue.serverTimestamp();
 } else if (type === 'complaint') {
 subscriberUpdate.status = 'complained';
 subscriberUpdate.complained_at = FieldValue.serverTimestamp();
 } else if (type === 'suppressed') {
 subscriberUpdate.status = 'suppressed';
 subscriberUpdate.isActive = false;
 subscriberUpdate.active = false;
 }

 await subscriberRef.set(subscriberUpdate, { merge: true });

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

 return { processed: true, type, email, campaignId };
}

// ── Job alert event handler (mirrors newsletter pattern) ────

async function persistJobAlertMailtrapEvent(db, { email, type, eventData, messageId, occurredAt }) {
 const FieldValue = admin.firestore.FieldValue;
 const subscriberRef = db.collection('job_alert_subscribers').doc(email);

 const topUpdate = { email, updated_at: FieldValue.serverTimestamp() };
 if (type === 'delivered') { topUpdate.last_delivered_at = FieldValue.serverTimestamp(); topUpdate.delivered_count = FieldValue.increment(1); }
 if (type === 'open') { topUpdate.last_open_at = FieldValue.serverTimestamp(); topUpdate.open_count = FieldValue.increment(1); }
 if (type === 'click') { topUpdate.last_click_at = FieldValue.serverTimestamp(); topUpdate.click_count = FieldValue.increment(1); topUpdate.last_clicked_url = eventData.url || ''; }
 if (type === 'bounce') { topUpdate.status = 'bounced'; topUpdate.last_bounced_at = FieldValue.serverTimestamp(); topUpdate.bounce_count = FieldValue.increment(1); }
 if (type === 'complaint') { topUpdate.status = 'complained'; topUpdate.last_complained_at = FieldValue.serverTimestamp(); }
 if (type === 'delivered' || type === 'open' || type === 'click') topUpdate.status = 'active';

 await subscriberRef.set(topUpdate, { merge: true });

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
