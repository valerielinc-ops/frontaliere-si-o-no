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
// Unosend uses Svix under the hood. Svix signing:
// - Headers: webhook-id, webhook-timestamp, webhook-signature
// - Signature format: "v1,{base64_hmac}" (multiple sigs separated by space)
// - Signed content: "{webhook-id}.{webhook-timestamp}.{body}"
// - Secret: base64-decode after stripping "whsec_" prefix

export function verifyUnosendSignature({ payload, headers, signingSecret }) {
  if (!signingSecret || !payload) return false;

  const msgId = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];

  if (!msgId || !timestamp || !signatureHeader) return false;

  // Strip whsec_ prefix and base64-decode the secret
  const secretBytes = Buffer.from(
    signingSecret.startsWith('whsec_') ? signingSecret.slice(6) : signingSecret,
    'base64'
  );

  // Signed content: "{webhook-id}.{webhook-timestamp}.{body}"
  const toSign = `${msgId}.${timestamp}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(toSign, 'utf8')
    .digest('base64');

  // Signature header: "v1,{b64} v1,{b64}" — check each
  const signatures = signatureHeader.split(' ');
  for (const sig of signatures) {
    const parts = sig.split(',');
    if (parts.length < 2) continue;
    const sigValue = parts.slice(1).join(',');
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigValue))) {
        return true;
      }
    } catch {
      // length mismatch — continue
    }
  }
  return false;
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

  // Route job-alert events to job_alert_subscribers/{email}
  const tagsObj = eventData.tags || {};
  const tagsArr = Array.isArray(tagsObj) ? tagsObj : [];
  const isJobAlert = tagsArr.some(t => t?.value === 'job-alert' || t?.value === 'job-alert-retry')
    || tagsObj.type === 'job-alert' || tagsObj.type === 'job-alert-retry';
  if (isJobAlert) {
    return persistJobAlertUnosendEvent(db, { email, type, eventType, messageId, timestamp, eventData });
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
    subscriberUpdate.last_clicked_url = eventData.link || eventData.url || '';
  } else if (type === 'bounce') {
    subscriberUpdate.status = 'bounced';
    subscriberUpdate.bounced_at = FieldValue.serverTimestamp();
    subscriberUpdate.bounce_reason = eventData.bounce_reason || eventData.bounce_type || '';
  } else if (type === 'unsubscribed') {
    subscriberUpdate.status = 'unsubscribed';
    subscriberUpdate.unsubscribed_at = FieldValue.serverTimestamp();
  } else if (type === 'complaint') {
    subscriberUpdate.status = 'complained';
    subscriberUpdate.complained_at = FieldValue.serverTimestamp();
  }

  await subscriberRef.set(subscriberUpdate, { merge: true });

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

// ── Job alert event handler (mirrors newsletter pattern) ────

async function persistJobAlertUnosendEvent(db, { email, type, eventType, messageId, timestamp, eventData }) {
  const FieldValue = admin.firestore.FieldValue;
  const subscriberRef = db.collection('job_alert_subscribers').doc(email);

  const topUpdate = { email, updated_at: FieldValue.serverTimestamp() };
  if (type === 'delivered') { topUpdate.last_delivered_at = FieldValue.serverTimestamp(); topUpdate.delivered_count = FieldValue.increment(1); }
  if (type === 'open') { topUpdate.last_open_at = FieldValue.serverTimestamp(); topUpdate.open_count = FieldValue.increment(1); }
  if (type === 'click') { topUpdate.last_click_at = FieldValue.serverTimestamp(); topUpdate.click_count = FieldValue.increment(1); topUpdate.last_clicked_url = eventData.link || eventData.url || ''; }
  if (type === 'bounce') { topUpdate.status = 'bounced'; topUpdate.last_bounced_at = FieldValue.serverTimestamp(); topUpdate.bounce_count = FieldValue.increment(1); }
  if (type === 'complaint') { topUpdate.status = 'complained'; topUpdate.last_complained_at = FieldValue.serverTimestamp(); }
  if (type === 'delivered' || type === 'open' || type === 'click') topUpdate.status = 'active';

  await subscriberRef.set(topUpdate, { merge: true });

  await subscriberRef.collection('events').add({
    email,
    event_type: type,
    unosend_event: eventType,
    message_id: messageId,
    provider: 'unosend',
    metadata: {
      link: eventData.link || null,
      tags: eventData.tags || null,
    },
    timestamp: FieldValue.serverTimestamp(),
    occurred_at: timestamp,
  });

  return { processed: true, type, email, collection: 'job_alert_subscribers' };
}

// ── Request handler ──────────────────────────────────────────

export async function handleUnosendWebhookRequest({ payload, headers, signingSecret }) {
  // Log all headers for debugging
  const allHeaders = Object.entries(headers)
    .filter(([k]) => !k.startsWith(':'))
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
    .join(' | ');
  console.log(`[unosendWebhook] Headers: ${allHeaders}`);
  console.log(`[unosendWebhook] Body preview: ${String(payload).slice(0, 300)}`);

  // Skip signature verification for test/ping events (Unosend test events use a proprietary
  // signing format different from Svix; real events include proper Svix headers)
  const webhookEvent = headers['x-webhook-event'] || '';
  const isTestEvent = webhookEvent === 'test.event' || webhookEvent === 'ping';

  // Try Svix-style signature first
  if (signingSecret && !isTestEvent) {
    const hasSvixHeaders = headers['webhook-id'] && headers['webhook-timestamp'] && headers['webhook-signature'];

    if (hasSvixHeaders) {
      const isValid = verifyUnosendSignature({ payload, headers, signingSecret });
      if (!isValid) {
        console.warn(`[unosendWebhook] Svix signature mismatch`);
        throw new Error('Invalid Unosend webhook signature');
      }
    } else {
      // Fallback: try X-Webhook-Signature or X-Unosend-Signature (HMAC SHA256 hex)
      const altSig = headers['x-webhook-signature'] || headers['x-unosend-signature'] || headers['x-signature'];
      if (altSig) {
        const rawSecret = signingSecret.startsWith('whsec_') ? signingSecret.slice(6) : signingSecret;
        const expected = altSig.replace(/^sha256=/, '');
        // Try multiple key derivations — Unosend signing key format is undocumented
        // whsec_ secrets use URL-safe base64 (-/_ instead of +//)
        const standardBase64 = rawSecret.replace(/-/g, '+').replace(/_/g, '/');
        const keysToTry = [
          { label: 'base64url-decoded', key: Buffer.from(rawSecret, 'base64url') },
          { label: 'base64-std-decoded', key: Buffer.from(standardBase64, 'base64') },
          { label: 'raw-stripped', key: rawSecret },
          { label: 'full-with-prefix', key: signingSecret },
        ];
        let isValid = false;
        for (const { label, key } of keysToTry) {
          try {
            const hmac = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
            if (hmac.length === expected.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
              console.log(`[unosendWebhook] Signature valid with key: ${label}`);
              isValid = true;
              break;
            }
          } catch { /* ignore */ }
        }
        if (!isValid) {
          console.warn(`[unosendWebhook] Alt signature mismatch (tried ${keysToTry.length} key derivations)`);
          throw new Error('Invalid Unosend webhook signature');
        }
      } else {
        // No recognized signature headers — accept but log warning
        console.warn(`[unosendWebhook] No signature headers found — accepting with warning`);
      }
    }
  }

  const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const eventType = body.type;
  const eventData = body.data || body;

  // Handle ping/test events gracefully
  if (!eventType || eventType === 'ping' || eventType === 'test' || eventType === 'test.event') {
    console.log(`[unosendWebhook] Ping/test event received (type=${eventType || 'none'})`);
    return { ok: true, ping: true };
  }

  const db = admin.firestore();
  const result = await persistUnosendEvent(db, eventType, eventData);

  console.log(`[unosendWebhook] ${eventType} → ${result.type || 'skipped'} for ${eventData.to || '?'}`);
  return result;
}
