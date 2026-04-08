import admin from 'firebase-admin';
import crypto from 'crypto';

/**
 * Mailgun webhook handler — receives delivery events and stores them in Firestore.
 *
 * Mailgun signs webhooks with HMAC-SHA256 using the HTTP webhook signing key.
 * Events: delivered, opened, clicked, failed, unsubscribed, complained, stored.
 *
 * Firestore paths (same as Resend/SES webhooks):
 *   newsletter_subscribers/{email}/events/{auto-id}
 *   newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 *   newsletter_subscribers/{email} (status updates: bounced, unsubscribed)
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
    case 'accepted':     return 'send';
    case 'delivered':    return 'delivered';
    case 'opened':       return 'open';
    case 'clicked':      return 'click';
    case 'failed':
    case 'rejected':     return 'bounce';
    case 'unsubscribed': return 'unsubscribed';
    case 'complained':   return 'complaint';
    case 'stored':       return 'stored';
    default:             return null;
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

  const subscriberRef = db.collection('newsletter_subscribers').doc(email);

  // Update subscriber-level status for critical events
  const subscriberUpdate = {
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (type === 'bounce') {
    subscriberUpdate.status = 'bounced';
    subscriberUpdate.bounced_at = admin.firestore.FieldValue.serverTimestamp();
    subscriberUpdate.bounce_reason = eventData['delivery-status']?.description || eventData.reason || '';
  } else if (type === 'unsubscribed') {
    subscriberUpdate.status = 'unsubscribed';
    subscriberUpdate.unsubscribed_at = admin.firestore.FieldValue.serverTimestamp();
  } else if (type === 'complaint') {
    subscriberUpdate.status = 'complained';
    subscriberUpdate.complained_at = admin.firestore.FieldValue.serverTimestamp();
  }

  if (Object.keys(subscriberUpdate).length > 1) {
    await subscriberRef.set(subscriberUpdate, { merge: true });
  }

  // Update campaign delivery doc
  const deliveryData = {
    email,
    campaign_id: campaignId,
    message_id: messageId,
    provider: 'mailgun',
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (type === 'send')      deliveryData.sent_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'delivered')  deliveryData.delivered_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'open')       deliveryData.opened_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'bounce')     deliveryData.bounced_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'complaint')  deliveryData.complained_at = admin.firestore.FieldValue.serverTimestamp();
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
