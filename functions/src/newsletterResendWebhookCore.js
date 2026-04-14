import admin from 'firebase-admin';
import { Resend } from 'resend';

function normalizeEmail(value) {
 return String(value || '').trim().toLowerCase();
}

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
 for (const tag of Array.isArray(tags) ? tags : []) {
 const name = sanitizeString(tag?.name);
 const value = sanitizeString(tag?.value);
 if (name && value) map[name] = value;
 }
 return map;
}

function buildDeliveryDocId(email, campaignId) {
 return `${campaignId}__${normalizeEmail(email)}`.replace(/[^a-z0-9@._-]+/gi, '-');
}

function buildSubscriberUpdate(eventType, data, currentStatus) {
 const FieldValue = admin.firestore.FieldValue;
 const update = {
 email: normalizeEmail(data.email),
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
 }
 if (eventType === 'open') {
 update.last_open_at = admin.firestore.FieldValue.serverTimestamp();
 update.lastOpenAt = admin.firestore.FieldValue.serverTimestamp();
 update.open_count = FieldValue.increment(1);
 update.openCount = FieldValue.increment(1);
 }
 if (eventType === 'click') {
 update.last_click_at = admin.firestore.FieldValue.serverTimestamp();
 update.lastClickAt = admin.firestore.FieldValue.serverTimestamp();
 update.click_count = FieldValue.increment(1);
 update.clickCount = FieldValue.increment(1);
 update.last_clicked_url = sanitizeString(data.link_url || data.target_url);
 update.last_clicked_section = sanitizeString(data.section_id);
 }
 if (eventType === 'bounce') {
 update.last_bounced_at = admin.firestore.FieldValue.serverTimestamp();
 update.status = 'bounced';
 update.isActive = false;
 update.active = false;
 }
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
 if (eventType === 'delivered' || eventType === 'open' || eventType === 'click') {
 const skipPromotion = !currentStatus || currentStatus === 'pending';
 if (!skipPromotion) {
 update.status = 'confirmed';
 update.isActive = true;
 update.active = true;
 }
 }

 return update;
}

function calculateEngagementScore(subscriberData) {
 const sendCount = Number(subscriberData?.send_count || subscriberData?.sendCount) || 0;
 const openCount = Number(subscriberData?.open_count || subscriberData?.openCount) || 0;
 const clickCount = Number(subscriberData?.click_count || subscriberData?.clickCount) || 0;
 const openRate = sendCount > 0 ? openCount / sendCount : 0;
 const clickRate = sendCount > 0 ? clickCount / sendCount : 0;
 const openScore = Math.min(40, Math.round(openRate * 80));
 const clickScore = Math.min(30, Math.round(clickRate * 150));
 const lastEngagement = subscriberData?.last_click_at || subscriberData?.last_open_at;
 let recencyScore = 0;
 if (lastEngagement) {
 const ts = typeof lastEngagement === 'object' && lastEngagement.toDate
 ? lastEngagement.toDate().getTime()
 : new Date(lastEngagement).getTime();
 const daysSince = (Date.now() - ts) / (1000 * 60 * 60 * 24);
 if (daysSince < 7) recencyScore = 30;
 else if (daysSince < 14) recencyScore = 25;
 else if (daysSince < 30) recencyScore = 18;
 else if (daysSince < 60) recencyScore = 10;
 else if (daysSince < 90) recencyScore = 5;
 }
 const score = Math.min(100, openScore + clickScore + recencyScore);
 const level = score >= 70 ? 'hot' : score >= 50 ? 'warm' : score >= 30 ? 'cool' : score >= 10 ? 'cold' : 'dormant';
 return { score, level };
}

export async function applyResendWebhookEvent(rawEvent, options = {}) {
 const db = options.db || getAdminDb();
 const type = mapWebhookType(rawEvent?.type);
 if (!type) {
 return { handled: false, reason: 'unsupported_event_type' };
 }

 const data = rawEvent?.data || {};
 const tags = extractTagMap(data.tags);
 const email = normalizeEmail(
 data.email
 || data.to?.[0]
 || data.to
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
 const alertId = sanitizeString(tags.alert_id) || 'unknown';
 await applyJobAlertEvent(db, { email, type, alertId, messageId, linkUrl, linkLabel, occurredAt, rawEvent });
 return { handled: true, email, type, collection: 'job_alert_subscribers', alertId };
 }

 // ── Newsletter events (existing behavior) ────────────────────
 const campaignId = sanitizeString(tags.campaign_id || data.campaign_id) || 'unknown';
 const variant = sanitizeString(tags.variant || data.variant) || 'general';
 const locale = sanitizeString(tags.subscriber_locale || data.locale) || 'it-IT';
 const sourceChannel = sanitizeString(tags.source_channel || data.source_channel);

 // Read current subscriber status to avoid promoting pending users
 let currentStatus = null;
 try {
 const subscriberDoc = await db.collection('newsletter_subscribers').doc(email).get();
 if (subscriberDoc.exists) {
 currentStatus = subscriberDoc.data()?.status || null;
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

 await db.collection('newsletter_subscribers').doc(email).set(subscriberUpdate, { merge: true });

 // Update engagement score after metrics change (FRO-17)
 if (type === 'open' || type === 'click' || type === 'send') {
 try {
 const updatedDoc = await db.collection('newsletter_subscribers').doc(email).get();
 if (updatedDoc.exists) {
 const { score, level } = calculateEngagementScore(updatedDoc.data());
 await db.collection('newsletter_subscribers').doc(email).set({
 engagement_score: score,
 engagement_level: level,
 engagement_updated_at: admin.firestore.FieldValue.serverTimestamp(),
 }, { merge: true });
 }
 } catch {
 // Non-critical — skip engagement score update
 }
 }

 await db.collection('newsletter_subscribers').doc(email).collection('campaign_deliveries').doc(buildDeliveryDocId(email, campaignId)).set({
 email,
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

 // ── Top-level subscriber document (aggregate counters) ──────
 const topUpdate = {
 email,
 updated_at: FieldValue.serverTimestamp(),
 };
 if (type === 'send') {
 topUpdate.last_sent_at = FieldValue.serverTimestamp();
 topUpdate.send_count = FieldValue.increment(1);
 }
 if (type === 'delivered') {
 topUpdate.last_delivered_at = FieldValue.serverTimestamp();
 topUpdate.delivered_count = FieldValue.increment(1);
 }
 if (type === 'open') {
 topUpdate.last_open_at = FieldValue.serverTimestamp();
 topUpdate.open_count = FieldValue.increment(1);
 }
 if (type === 'click') {
 topUpdate.last_click_at = FieldValue.serverTimestamp();
 topUpdate.click_count = FieldValue.increment(1);
 topUpdate.last_clicked_url = linkUrl;
 }
 if (type === 'bounce') {
 topUpdate.last_bounced_at = FieldValue.serverTimestamp();
 topUpdate.bounce_count = FieldValue.increment(1);
 topUpdate.status = 'bounced';
 }
 if (type === 'complaint') {
 topUpdate.last_complained_at = FieldValue.serverTimestamp();
 topUpdate.status = 'complained';
 }
 if (type === 'failed') {
 topUpdate.last_failed_at = FieldValue.serverTimestamp();
 topUpdate.fail_count = FieldValue.increment(1);
 }
 // Healthy delivery events → mark as active
 if (type === 'delivered' || type === 'open' || type === 'click') {
 topUpdate.status = 'active';
 }

 await subscriberRef.set(topUpdate, { merge: true });

 // ── Engagement score ────────────────────────────────────────
 if (type === 'open' || type === 'click' || type === 'send') {
 try {
 const doc = await subscriberRef.get();
 if (doc.exists) {
 const { score, level } = calculateEngagementScore(doc.data());
 await subscriberRef.set({
 engagement_score: score,
 engagement_level: level,
 engagement_updated_at: FieldValue.serverTimestamp(),
 }, { merge: true });
 }
 } catch {
 // Non-critical
 }
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
 await subscriberRef.collection('events').add({
 email,
 event_type: type,
 alert_id: alertId,
 message_id: messageId,
 link_url: linkUrl,
 link_label: linkLabel,
 metadata: rawEvent,
 timestamp: FieldValue.serverTimestamp(),
 occurred_at: occurredAt,
 });
}

export async function handleResendWebhookRequest({ payload, headers, webhookSecret }) {
 const verifiedEvent = verifyResendWebhookSignature({ payload, headers, webhookSecret });
 return applyResendWebhookEvent(verifiedEvent);
}
