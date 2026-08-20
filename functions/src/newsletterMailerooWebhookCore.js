import admin from 'firebase-admin';
import crypto from 'crypto';
import { refreshEngagementScore } from './lib/engagementScore.js';
import { refreshPreferredSendHour } from './lib/preferredSendHour.js';
import { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS, lookupSentVariant } from './lib/emailExperimentPostHog.js';
import { classifyBounceSeverity, bounceUpdateFields, softBounceRecoveryFields, maybeEscalateSoftBounce } from './lib/bounceClassification.js';
import { campaignIdFromTags } from './lib/mailerooRef.js';
import { positiveEventRecoveryFields, positiveEventStatusFields } from './lib/subscriberReactivation.js';
import { normalizeEmailAddress } from './lib/parseEmailField.js';

/**
 * Maileroo webhook handler — receives delivery events and stores them in Firestore.
 *
 * Maileroo signs each webhook with HMAC-SHA256 over the raw request body using a
 * shared secret (Maileroo dashboard → Webhooks). The signature is sent in the
 * `x-maileroo-signature` header as a hex digest (optionally prefixed "sha256=").
 *
 * Event types (Maileroo): accepted, delivered, rejected, deferred, failed,
 * opened, clicked, complained. Payloads may be a single event object or a
 * batch under { events: [...] }.
 *
 * Firestore paths (same as other provider webhooks):
 *   newsletter_subscribers/{email}/events/{auto-id}
 *   newsletter_subscribers/{email}/campaign_deliveries/{campaign-id}
 *   newsletter_subscribers/{email} (status updates: bounced, complained)
 *   job_alert_subscribers/{email} (when tagged type=job-alert)
 */

// ── Signature verification ───────────────────────────────────
// HMAC-SHA256(rawBody, secret) → hex, compared against x-maileroo-signature.

export function verifyMailerooSignature({ payload, signature, signingSecret }) {
  if (!signingSecret || !payload || !signature) return false;
  const provided = String(signature).replace(/^sha256=/i, '').trim();
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(payload, 'utf8')
    .digest('hex');
  try {
    return provided.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Event type mapping (Maileroo → normalized types) ─────────

function mapMailerooEvent(type) {
  switch (String(type || '').toLowerCase()) {
    case 'accepted':   return 'send';
    case 'delivered':  return 'delivered';
    case 'opened':     return 'open';
    case 'clicked':    return 'click';
    case 'rejected':   return 'bounce';
    case 'failed':     return 'bounce';
    case 'complained': return 'complaint';
    // 'deferred' is transient (retry in progress) — no terminal state to record.
    default: return null;
  }
}

// ── Extract identifiers from a Maileroo event ────────────────

/**
 * Maileroo echoes `tags` back in BOTH shapes depending on the event, and the
 * array form was silently unhandled until 2026-08-20: the `!Array.isArray`
 * guard below used to skip it and fall through to the message id, so every
 * lifecycle send whose tags arrived as `[{name:'campaign_id', value:'...'}]`
 * was filed under a raw message id instead of its campaign. Measured over
 * 1-20 August 2026 that was 7.945 messages whose campaign could not be told
 * from the event alone. campaignIdFromTags accepts both shapes; the fallback
 * to the message id stays, because an event with no campaign tag at all still
 * needs a stable key.
 */
function extractCampaignId(event) {
  const fromTags = campaignIdFromTags(event.tags);
  if (fromTags) return fromTags;
  return event.message_reference_id || event.message_id || 'unknown';
}

function getRecipient(event) {
  const data = event.event_data || {};
  return normalizeEmailAddress(data.to || event.to);
}

function isJobAlertEvent(event) {
  const tags = event.tags || {};
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    return tags.type === 'job-alert' || tags.type === 'job-alert-retry';
  }
  return false;
}

function getOccurredAt(event) {
  const t = event.event_time ?? event.inserted_at;
  if (typeof t === 'number') return new Date(t * 1000).toISOString();
  if (typeof t === 'string' && t) return t;
  return new Date().toISOString();
}

// ── Resolve the refId → recipient lookup record ──────────────
// Primary location is newsletter_subscribers/_meta_/maileroo_refs/{refId} (aligned
// with the rest of the tracking). The legacy top-level maileroo_message_meta is read
// as a fallback so in-flight messages sent before this change still attribute their
// opens/clicks during the transition window.
async function readMailerooRef(db, refId) {
  const primary = (await db.collection('newsletter_subscribers').doc('_meta_')
    .collection('maileroo_refs').doc(refId).get()).data();
  if (primary && typeof primary.email === 'string' && primary.email.includes('@')) {
    return primary;
  }
  const legacy = (await db.collection('maileroo_message_meta').doc(refId).get()).data();
  return legacy || primary || null;
}

// ── Persist a single event to Firestore ──────────────────────

export async function persistMailerooEvent(db, event) {
  const type = mapMailerooEvent(event.event_type);
  if (!type) return { skipped: true, reason: `unknown_event: ${event.event_type}` };

  const FieldValue = admin.firestore.FieldValue;
  const refId = event.message_reference_id || event.message_id || '';

  // Maileroo 'opened'/'clicked' events carry NEITHER the recipient nor tags —
  // only message_reference_id. The send pipeline (persistDelivery) writes an
  // authoritative lookup record at newsletter_subscribers/_meta_/maileroo_refs/
  // {referenceId} with the real recipient, campaign id and job-alert flag. Read it
  // (keyed by refId) to resolve the subscriber for opens/clicks and to enrich
  // campaign/routing that the webhook payload itself omits. Falls back to the event
  // fields when the record is absent (e.g. an 'accepted'/'delivered' event, which
  // does carry the recipient in event_data.to).
  const metaDoc = refId ? await readMailerooRef(db, refId) : null;
  // The lookup record is only authoritative if it actually resolved an email.
  const meta = (metaDoc && typeof metaDoc.email === 'string' && metaDoc.email.includes('@')) ? metaDoc : null;
  const email = meta ? meta.email : getRecipient(event);
  if (!email || !email.includes('@')) return { skipped: true, reason: 'invalid_email' };

  const isJobAlert = meta ? !!meta.is_job_alert : isJobAlertEvent(event);
  const campaignId = (meta && meta.campaign_id) ? meta.campaign_id : extractCampaignId(event);
  const messageId = event.message_id || event.message_reference_id || '';
  const occurredAt = getOccurredAt(event);
  const data = event.event_data || {};
  const clickedUrl = data.original_url || data.url || '';
  const bounceReason = data.reason || data.reject_reason || '';

  if (isJobAlert) {
    return persistJobAlertMailerooEvent(db, { email, type, event, messageId, occurredAt, clickedUrl, campaignId });
  }

  const subscriberRef = db.collection('newsletter_subscribers').doc(email);

  const subscriberUpdate = {
    updated_at: FieldValue.serverTimestamp(),
  };

  let bounceSeverity = null;

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
    subscriberUpdate.last_clicked_url = clickedUrl;
    Object.assign(subscriberUpdate, softBounceRecoveryFields());
  } else if (type === 'bounce') {
    bounceSeverity = classifyBounceSeverity({ provider: 'maileroo', rawEvent: event.event_type, eventData: data });
    Object.assign(subscriberUpdate, bounceUpdateFields({ severity: bounceSeverity, reason: bounceReason }));
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
    await maybeEscalateSoftBounce(subscriberRef, bounceReason);
  }

  // Refresh engagement score after counter changes (FRO-17)
  if (type === 'open' || type === 'click' || type === 'send') {
    await refreshEngagementScore(subscriberRef, FieldValue);
  }

  const deliveryData = {
    email,
    campaign_id: campaignId,
    message_id: messageId,
    provider: 'maileroo',
    updated_at: FieldValue.serverTimestamp(),
  };

  if (type === 'send') deliveryData.sent_at = FieldValue.serverTimestamp();
  if (type === 'delivered') deliveryData.delivered_at = FieldValue.serverTimestamp();
  if (type === 'open') deliveryData.opened_at = FieldValue.serverTimestamp();
  if (type === 'bounce') deliveryData.bounced_at = FieldValue.serverTimestamp();
  if (type === 'complaint') deliveryData.complained_at = FieldValue.serverTimestamp();
  if (type === 'click') {
    deliveryData.clicked_at = FieldValue.serverTimestamp();
    deliveryData.last_clicked_url = clickedUrl;
    deliveryData.clicked_links = FieldValue.increment(1);
  }

  const deliveryDocId = `${campaignId}_${email}`.replace(/[/\\]/g, '_').slice(0, 200);
  await subscriberRef.collection('campaign_deliveries').doc(deliveryDocId).set(deliveryData, { merge: true });

  await subscriberRef.collection('events').add({
    email,
    event_type: type,
    maileroo_event: event.event_type,
    campaign_id: campaignId,
    message_id: messageId,
    provider: 'maileroo',
    metadata: {
      event_id: event.event_id || null,
      reason: bounceReason || null,
      original_url: clickedUrl || null,
      ip: data.ip || null,
      user_agent: data.user_agent || null,
      tags: event.tags || null,
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
    const { variant, isOperatorVerification } = await lookupSentVariant(subscriberRef, campaignId, email);
    if (!isOperatorVerification) {
      await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.OPENED, { email, provider: 'maileroo', campaignId, variant });
    }
  }
  return { processed: true, type, email, campaignId };
}

// ── Job alert event handler (mirrors newsletter pattern) ─────

async function persistJobAlertMailerooEvent(db, { email, type, event, messageId, occurredAt, clickedUrl }) {
  const FieldValue = admin.firestore.FieldValue;
  const subscriberRef = db.collection('job_alert_subscribers').doc(email);

  const topUpdate = { email, updated_at: FieldValue.serverTimestamp() };
  let bounceSeverity = null;
  let bounceReasonText = '';
  if (type === 'delivered') { topUpdate.last_delivered_at = FieldValue.serverTimestamp(); topUpdate.delivered_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
  if (type === 'open') { topUpdate.last_open_at = FieldValue.serverTimestamp(); topUpdate.open_count = FieldValue.increment(1); Object.assign(topUpdate, softBounceRecoveryFields()); }
  if (type === 'click') { topUpdate.last_click_at = FieldValue.serverTimestamp(); topUpdate.click_count = FieldValue.increment(1); topUpdate.last_clicked_url = clickedUrl; Object.assign(topUpdate, softBounceRecoveryFields()); }
  if (type === 'bounce') {
    const data = event.event_data || {};
    bounceSeverity = classifyBounceSeverity({ provider: 'maileroo', rawEvent: event.event_type, eventData: data });
    bounceReasonText = data.reason || data.reject_reason || '';
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
    maileroo_event: event.event_type,
    message_id: messageId,
    provider: 'maileroo',
    metadata: {
      original_url: clickedUrl || null,
      tags: event.tags || null,
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

export async function handleMailerooWebhookRequest({ payload, headers, signingSecret }) {
  const sigHeader = headers?.['x-maileroo-signature'] || headers?.['X-Maileroo-Signature'];

  if (signingSecret) {
    if (!verifyMailerooSignature({ payload, signature: sigHeader, signingSecret })) {
      console.warn('[mailerooWebhook] Signature mismatch or missing');
      throw new Error('Invalid Maileroo webhook signature');
    }
  }

  const body = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});

  // Support both a single event object and a batched { events: [...] } payload.
  const events = Array.isArray(body.events) ? body.events : (body.event_type ? [body] : []);
  if (events.length === 0) {
    console.log('[mailerooWebhook] No events in payload (ping or empty batch)');
    return { ok: true, ping: true };
  }

  const db = admin.firestore();
  const results = [];
  for (const event of events) {
    try {
      const result = await persistMailerooEvent(db, event);
      results.push(result);
      console.log(`[mailerooWebhook] ${event.event_type} → ${result.type || 'skipped'} for ${getRecipient(event) || '?'}`);
    } catch (err) {
      console.error(`[mailerooWebhook] Error processing ${event.event_type}: ${err.message}`);
      results.push({ error: err.message, event: event.event_type });
    }
  }

  return { processed: results.length, results };
}
