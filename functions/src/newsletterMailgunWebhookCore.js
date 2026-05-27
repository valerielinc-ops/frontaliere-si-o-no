import admin from 'firebase-admin';
import crypto from 'crypto';
import { refreshEngagementScore } from './lib/engagementScore.js';

/**
 * Mailgun webhook handler — receives delivery events and stores them in Firestore.
 *
 * Mailgun signs webhooks with HMAC-SHA256 using the HTTP webhook signing key.
 * Events: delivered, opened, clicked, failed, unsubscribed, complained, stored.
 *
 * Firestore paths (same as Resend/SES webhooks):
 * newsletter_subscribers/{email}/events/{auto-id}
 * newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 * newsletter_subscribers/{email} (status updates: bounced, unsubscribed)
 */

function normalizeEmail(value) {
 return String(value || '').trim().toLowerCase();
}

// ── Signature verification ───────────────────────────────────

export function verifyMailgunSignature({ timestamp, token, signature, signingKey }) {
 if (!signingKey || !timestamp || !token || !signature) return false;
 const hmac = crypto.createHmac('sha256', signingKey);
 hmac.update(timestamp + token);
 const expected = hmac.digest('hex');
 return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Event type mapping (Mailgun → our normalized types) ──────

function mapMailgunEvent(event) {
 switch (String(event || '').toLowerCase()) {
 case 'accepted': return 'send';
 case 'delivered': return 'delivered';
 case 'opened': return 'open';
 case 'clicked': return 'click';
 case 'failed':
 case 'rejected': return 'bounce';
 case 'unsubscribed': return 'unsubscribed';
 case 'complained': return 'complaint';
 case 'stored': return 'stored';
 default: return null;
 }
}

// ── Extract campaign/message IDs from Mailgun headers ────────

function extractCampaignId(eventData) {
 // Check custom headers first (X-Campaign-Id)
 const headers = eventData.message?.headers || {};
 if (headers['x-campaign-id']) return headers['x-campaign-id'];

 // Check Mailgun tags
 const tags = eventData.tags || [];
 for (const tag of tags) {
 if (tag.startsWith('campaign:')) return tag.slice(9);
 }

 // Fallback: use message-id
 return headers['message-id'] || eventData.id || 'unknown';
}

function extractMessageId(eventData) {
 return eventData.message?.headers?.['message-id'] || eventData.id || '';
}

// ── Persist event to Firestore ───────────────────────────────

async function persistMailgunEvent(db, eventData) {
 const email = normalizeEmail(eventData.recipient);
 if (!email || !email.includes('@')) return { skipped: true, reason: 'invalid_email' };

 const mgEvent = eventData.event;
 const type = mapMailgunEvent(mgEvent);
 if (!type) return { skipped: true, reason: `unknown_event: ${mgEvent}` };

 const campaignId = extractCampaignId(eventData);
 const messageId = extractMessageId(eventData);
 const timestamp = eventData.timestamp
 ? new Date(eventData.timestamp * 1000).toISOString()
 : new Date().toISOString();

 // Route job-alert events to job_alert_subscribers/{email}
 const mgTags = eventData.tags || [];
 if (mgTags.includes('job-alert') || mgTags.includes('job-alert-retry')) {
 return persistJobAlertMailgunEvent(db, { email, type, mgEvent, messageId, timestamp, eventData });
 }

 const subscriberRef = db.collection('newsletter_subscribers').doc(email);

 // Update subscriber-level fields for all event types (aligned with Resend handler)
 const FieldValue = admin.firestore.FieldValue;
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
 subscriberUpdate.bounce_reason = eventData['delivery-status']?.description || eventData.reason || '';
 } else if (type === 'unsubscribed') {
 subscriberUpdate.status = 'unsubscribed';
 subscriberUpdate.unsubscribed_at = FieldValue.serverTimestamp();
 } else if (type === 'complaint') {
 subscriberUpdate.status = 'complained';
 subscriberUpdate.complained_at = FieldValue.serverTimestamp();
 }

 await subscriberRef.set(subscriberUpdate, { merge: true });

 // Refresh engagement score after counter changes (FRO-17)
 if (type === 'open' || type === 'click' || type === 'send') {
 await refreshEngagementScore(subscriberRef, FieldValue);
 }

 // Update campaign delivery doc
 const deliveryData = {
 email,
 campaign_id: campaignId,
 message_id: messageId,
 provider: 'mailgun',
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
 mailgun_event: mgEvent,
 campaign_id: campaignId,
 message_id: messageId,
 provider: 'mailgun',
 metadata: {
 severity: eventData.severity || null,
 reason: eventData.reason || null,
 delivery_status: eventData['delivery-status'] || null,
 url: eventData.url || null,
 ip: eventData.ip || null,
 geolocation: eventData.geolocation || null,
 client_info: eventData['client-info'] || null,
 tags: eventData.tags || [],
 },
 timestamp: admin.firestore.FieldValue.serverTimestamp(),
 occurred_at: timestamp,
 });

 return { processed: true, type, email, campaignId };
}

// ── Job alert event handler (mirrors newsletter pattern) ────

async function persistJobAlertMailgunEvent(db, { email, type, mgEvent, messageId, timestamp, eventData }) {
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
 mailgun_event: mgEvent,
 message_id: messageId,
 provider: 'mailgun',
 metadata: {
 url: eventData.url || null,
 tags: eventData.tags || [],
 },
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: timestamp,
 });

 return { processed: true, type, email, collection: 'job_alert_subscribers' };
}

// ── Request handler ──────────────────────────────────────────

export async function handleMailgunWebhookRequest({ body, signingKey }) {
 // Mailgun sends event data in body.event-data and signature in body.signature
 const signature = body?.signature;
 const eventData = body?.['event-data'];

 if (!signature || !eventData) {
 throw new Error('Invalid Mailgun webhook payload: missing signature or event-data');
 }

 // Verify signature
 const isValid = verifyMailgunSignature({
 timestamp: signature.timestamp,
 token: signature.token,
 signature: signature.signature,
 signingKey,
 });

 if (!isValid) {
 throw new Error('Invalid Mailgun webhook signature');
 }

 const db = admin.firestore();
 const result = await persistMailgunEvent(db, eventData);

 console.log(`[mailgunWebhook] ${eventData.event} → ${result.type || 'skipped'} for ${eventData.recipient || '?'}`);
 return result;
}
