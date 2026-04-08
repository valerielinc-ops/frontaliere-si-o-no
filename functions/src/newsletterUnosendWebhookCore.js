import admin from 'firebase-admin';
import crypto from 'crypto';

/**
 * Unosend webhook handler — receives delivery events and stores them in Firestore.
 *
 * Unosend signs webhooks with HMAC-SHA256 using a signing secret.
 * Signature is in the X-Unosend-Signature header as "sha256={hex}".
 * Events: email.sent, email.delivered, email.opened, email.clicked,
 *         email.bounced, email.complained, contact.unsubscribed.
 *
 * Firestore paths (same as Resend/Mailgun webhooks):
 *   newsletter_subscribers/{email}/events/{auto-id}
 *   newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 *   newsletter_subscribers/{email} (status updates: bounced, unsubscribed)
 */

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// ── Signature verification ───────────────────────────────────

export function verifyUnosendSignature({ payload, signature, signingSecret }) {
  if (!signingSecret || !payload || !signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', signingSecret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Event type mapping (Unosend → our normalized types) ──────

function mapUnosendEvent(type) {
  switch (String(type || '').toLowerCase()) {
    case 'email.sent':          return 'send';
    case 'email.delivered':     return 'delivered';
    case 'email.opened':        return 'open';
    case 'email.clicked':       return 'click';
    case 'email.bounced':       return 'bounce';
    case 'email.failed':        return 'bounce';
    case 'email.complained':    return 'complaint';
    case 'contact.unsubscribed': return 'unsubscribed';
    default:                    return null;
  }
}

// ── Extract IDs from Unosend event data ──────────────────────

function extractCampaignId(data) {
  const tags = data.tags || {};
  if (tags.campaign) return tags.campaign;
  if (typeof tags === 'object') {
    for (const [k, v] of Object.entries(tags)) {
      if (k === 'campaign' || k === 'campaign_id') return String(v);
    }
  }
  return data.email_id || data.id || 'unknown';
}

// ── Persist event to Firestore ───────────────────────────────

async function persistUnosendEvent(db, eventType, eventData) {
  const email = normalizeEmail(eventData.to);
  if (!email || !email.includes('@')) return { skipped: true, reason: 'invalid_email' };

  const type = mapUnosendEvent(eventType);
  if (!type) return { skipped: true, reason: `unknown_event: ${eventType}` };

  const campaignId = extractCampaignId(eventData);
  const messageId = eventData.email_id || '';
  const timestamp = eventData.created_at || new Date().toISOString();

  const subscriberRef = db.collection('newsletter_subscribers').doc(email);

  // Update subscriber-level status for critical events
  const subscriberUpdate = {
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (type === 'bounce') {
    subscriberUpdate.status = 'bounced';
    subscriberUpdate.bounced_at = admin.firestore.FieldValue.serverTimestamp();
    subscriberUpdate.bounce_reason = eventData.bounce_reason || eventData.bounce_type || '';
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
    provider: 'unosend',
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (type === 'send')      deliveryData.sent_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'delivered')  deliveryData.delivered_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'open')       deliveryData.opened_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'bounce')     deliveryData.bounced_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'complaint')  deliveryData.complained_at = admin.firestore.FieldValue.serverTimestamp();
  if (type === 'click') {
    deliveryData.clicked_at = admin.firestore.FieldValue.serverTimestamp();
    deliveryData.last_clicked_url = eventData.link || eventData.url || '';
    deliveryData.clicked_links = admin.firestore.FieldValue.increment(1);
  }

  const deliveryDocId = `${campaignId}_${email}`.replace(/[/\\]/g, '_').slice(0, 200);
  await subscriberRef.collection('campaign_deliveries').doc(deliveryDocId).set(deliveryData, { merge: true });

  // Append to events log
  await subscriberRef.collection('events').add({
    email,
    event_type: type,
    unosend_event: eventType,
    campaign_id: campaignId,
    message_id: messageId,
    provider: 'unosend',
    metadata: {
      bounce_type: eventData.bounce_type || null,
      bounce_reason: eventData.bounce_reason || null,
      link: eventData.link || null,
      ip: eventData.ip_address || null,
      user_agent: eventData.user_agent || null,
      tags: eventData.tags || null,
    },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    occurred_at: timestamp,
  });

  return { processed: true, type, email, campaignId };
}

// ── Request handler ──────────────────────────────────────────

export async function handleUnosendWebhookRequest({ payload, headers, signingSecret }) {
  // Verify signature
  const signature = headers['x-unosend-signature'] || '';
  if (signingSecret) {
    const isValid = verifyUnosendSignature({ payload, signature, signingSecret });
    if (!isValid) {
      throw new Error('Invalid Unosend webhook signature');
    }
  }

  const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const eventType = body.type;
  const eventData = body.data || body;

  if (!eventType) {
    throw new Error('Invalid Unosend webhook payload: missing type');
  }

  const db = admin.firestore();
  const result = await persistUnosendEvent(db, eventType, eventData);

  console.log(`[unosendWebhook] ${eventType} → ${result.type || 'skipped'} for ${eventData.to || '?'}`);
  return result;
}
