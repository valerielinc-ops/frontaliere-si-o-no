/**
 * Opens and clicks of the e-mails the candidate receives about an assisted
 * application (owner request 2026-09-30): the admin panel shows, per e-mail,
 * whether it arrived, was opened and whether a link in it was clicked.
 *
 * Each send is tagged with a campaign id naming its ledger and notification
 * key. Child application emails use `aa--{orderId}--{key}`; Application
 * Concierge payment receipts use `ac--{serviceId}--{key}`. The four provider
 * webhooks recognise these campaigns before anything else and record the event
 * on the order or parent service: it never reaches newsletter engagement of
 * the address, nor job-ranking clicks. Maileroo reports opens and clicks with
 * neither the recipient nor the tags, so its sends also write the usual
 * reference record (functions/src/lib/mailerooRef.js), which carries the
 * campaign id.
 *
 * Opens are indicative: Apple Mail and some corporate filters open every
 * message on delivery.
 */

import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_PAYMENT_RECOVERY_COLLECTION,
} from './assistedApplicationConstants.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION } from './applicationConciergeConstants.js';
import { makeMailerooRefOnSent } from './lib/mailerooRef.js';

export const ASSISTED_EMAIL_TYPE = 'assisted-application';
export const CONCIERGE_EMAIL_TYPE = 'application-concierge';
export const EMAIL_EVENTS_SUBCOLLECTION = 'email_events';
const CAMPAIGN_RE = /^(aa|ac)--([A-Za-z0-9_-]{1,64}?)--([a-z0-9_]{1,60})$/;
const CAMPAIGN_MAX_LENGTH = 64;
const COUNTERS = {
  send: 'providerAccepted',
  accepted: 'providerAccepted',
  delivered: 'delivered',
  open: 'opens',
  click: 'clicks',
  bounce: 'bounces',
  complaint: 'complaints',
};
const LAST_AT = {
  send: 'providerAcceptedAt',
  accepted: 'providerAcceptedAt',
  delivered: 'deliveredAt',
  open: 'lastOpenAt',
  click: 'lastClickAt',
  bounce: 'bouncedAt',
  complaint: 'complainedAt',
};
const PAYMENT_RECOVERY_DIGEST_RE = /^digest-[A-Za-z0-9_-]{1,64}$/;

function campaignId(prefix, identifier, key) {
  const cleanIdentifier = String(identifier || '').replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  const cleanKey = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'unknown';
  const maxKeyLength = Math.min(60, CAMPAIGN_MAX_LENGTH - prefix.length - 3);
  const name = cleanKey.slice(0, maxKeyLength);
  const maxIdentifierLength = Math.max(1, CAMPAIGN_MAX_LENGTH - prefix.length - 2 - name.length);
  return `${prefix}${cleanIdentifier.slice(0, maxIdentifierLength)}--${name}`;
}

/** `aa--{orderId}--{key}`: Resend tag values allow letters, digits, `_` and `-` only. */
export function assistedCampaignId(orderId, key) {
  return campaignId('aa--', orderId, key);
}

/** Stable campaign id for one Application Concierge service notification. */
export function conciergeCampaignId(serviceId, key) {
  return campaignId('ac--', serviceId, key);
}

/** @returns {{orderId:string, key:string}|{serviceId:string, key:string}|null} */
export function parseAssistedCampaign(value) {
  const raw = String(value || '');
  if (raw.length > CAMPAIGN_MAX_LENGTH) return null;
  const match = CAMPAIGN_RE.exec(raw);
  if (!match) return null;
  return match[1] === 'ac'
    ? { serviceId: match[2], key: match[3] }
    : { orderId: match[2], key: match[3] };
}

/**
 * What a candidate e-mail adds to its payload: the tags the webhooks route on,
 * and click tracking unless the links must stay untouched (a forwarded
 * employer message keeps the employer's own links).
 */
export function assistedEmailTracking(orderId, key, { clicks = true } = {}) {
  return {
    tags: [
      { name: 'type', value: ASSISTED_EMAIL_TYPE },
      { name: 'campaign_id', value: assistedCampaignId(orderId, key) },
    ],
    tracking: Boolean(clicks),
  };
}

/** What a parent-service receipt adds to its provider payload. */
export function conciergeEmailTracking(serviceId, key, { clicks = true } = {}) {
  return {
    tags: [
      { name: 'type', value: CONCIERGE_EMAIL_TYPE },
      { name: 'campaign_id', value: conciergeCampaignId(serviceId, key) },
    ],
    tracking: Boolean(clicks),
  };
}

function eventTargetRef(db, target) {
  if (target.serviceId) return db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(target.serviceId);
  return PAYMENT_RECOVERY_DIGEST_RE.test(target.orderId)
    ? db.collection(ASSISTED_APPLICATION_PAYMENT_RECOVERY_COLLECTION).doc(target.orderId)
    : db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(target.orderId);
}

/** The cascade's onSent: the Maileroo reference record with the campaign id. */
export function assistedMailerooRefOnSent(db) {
  return makeMailerooRefOnSent(async () => db, { isJobAlert: false });
}

/** A clicked link without its query: review links carry a signed token. */
function linkWithoutQuery(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {
    return '';
  }
}

function eventDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Record one provider event for a candidate e-mail or parent-service receipt. Webhooks are delivered at
 * least once: one document per provider event, and the counters on the order
 * move only when that document is new.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{campaign:string, type:string, provider:string, messageId?:string, occurredAt?:string|Date, url?:string}} event
 * @returns {Promise<{assisted:true, recorded:boolean, reason?:string}>}
 */
export async function recordAssistedEmailEvent(db, { campaign, type, provider, messageId = '', occurredAt, url = '' }) {
  const target = parseAssistedCampaign(campaign);
  if (!target) return { assisted: true, recorded: false, reason: 'unknown_campaign' };
  const eventType = type === 'accepted' ? 'send' : type;
  // Provider acceptance is part of the parent-service receipt contract. Keep
  // the older child-application event surface unchanged: its dashboard only
  // counts delivery/engagement events and must not acquire a new send counter
  // merely because the shared webhook router learned about concierge receipts.
  if (!COUNTERS[eventType] || (eventType === 'send' && !target.serviceId)) {
    return { assisted: true, recorded: false, reason: `untracked_type:${type}` };
  }
  const at = eventDate(occurredAt);
  const link = eventType === 'click' ? linkWithoutQuery(url) : '';
  const targetRef = eventTargetRef(db, target);
  const order = await targetRef.get();
  if (!order.exists) return { assisted: true, recorded: false, reason: 'order_not_found' };

  const eventId = createHash('sha256')
    .update([provider, messageId, eventType, at.toISOString(), link].join('|'))
    .digest('hex')
    .slice(0, 40);
  try {
    await targetRef.collection(EMAIL_EVENTS_SUBCOLLECTION).doc(eventId).create({
      key: target.key,
      type: eventType,
      provider: String(provider || '').slice(0, 20),
      messageId: String(messageId || '').slice(0, 200),
      at,
      ...(link ? { url: link } : {}),
    });
  } catch (error) {
    // ALREADY_EXISTS: the provider delivered the same event again.
    if (error?.code === 6 || /already exists/i.test(String(error?.message || ''))) {
      return { assisted: true, recorded: false, reason: 'duplicate' };
    }
    throw error;
  }

  const base = `emailEngagement.${target.key}`;
  const update = {
    [`${base}.${COUNTERS[eventType]}`]: FieldValue.increment(1),
    [`${base}.${LAST_AT[eventType]}`]: at,
  };
  if (eventType === 'open' && !order.get(`${base}.firstOpenAt`)) update[`${base}.firstOpenAt`] = at;
  if (link) update[`${base}.lastClickUrl`] = link;
  const notificationBase = `notifications.${target.key}`;
  const currentDeliveryStatus = order.get(`${notificationBase}.deliveryStatus`);
  if (eventType === 'send') {
    update[`${notificationBase}.providerStatus`] = 'accepted';
    update[`${notificationBase}.providerAcceptedAt`] = at;
  } else if (eventType === 'delivered' && !['bounced', 'complained'].includes(currentDeliveryStatus)) {
    update[`${notificationBase}.deliveryStatus`] = 'delivered';
    update[`${notificationBase}.deliveredAt`] = at;
  } else if (eventType === 'bounce' && currentDeliveryStatus !== 'complained') {
    update[`${notificationBase}.deliveryStatus`] = 'bounced';
    update[`${notificationBase}.bouncedAt`] = at;
  } else if (eventType === 'complaint') {
    update[`${notificationBase}.deliveryStatus`] = 'complained';
    update[`${notificationBase}.complainedAt`] = at;
  }
  await targetRef.update(update);
  return { assisted: true, recorded: true };
}

function eventCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function timestampToIso(value) {
  if (!value) return null;
  const millis = typeof value?.toMillis === 'function'
    ? value.toMillis()
    : value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null;
}

/** Admin projection for the two payment receipts on an Application Concierge service. */
export function conciergePaidEmailViews(data = {}) {
  const engagement = data.emailEngagement && typeof data.emailEngagement === 'object' ? data.emailEngagement : {};
  const notifications = data.notifications && typeof data.notifications === 'object' ? data.notifications : {};
  return ['customer', 'owner'].map((audience) => {
    const key = `concierge_paid_${audience}`;
    const events = engagement[key] && typeof engagement[key] === 'object' ? engagement[key] : {};
    const sent = notifications[key] && typeof notifications[key] === 'object' ? notifications[key] : {};
    const providerAccepted = eventCount(events.providerAccepted);
    const delivered = eventCount(events.delivered);
    const bounces = eventCount(events.bounces);
    const complaints = eventCount(events.complaints);
    const providerStatusValue = sent.providerStatus
      || (providerAccepted || sent.status === 'sent' ? 'accepted' : sent.status === 'failed' ? 'failed' : 'unknown');
    const providerStatus = ['accepted', 'failed', 'unknown'].includes(providerStatusValue)
      ? providerStatusValue
      : 'unknown';
    const deliveryStatus = complaints > 0
      ? 'complained'
      : bounces > 0
        ? 'bounced'
        : delivered > 0
          ? 'delivered'
          : ['delivered', 'bounced', 'complained'].includes(sent.deliveryStatus) ? sent.deliveryStatus : 'unknown';
    return {
      audience,
      key,
      status: typeof sent.status === 'string' ? sent.status : null,
      providerStatus,
      deliveryStatus,
      provider: typeof sent.provider === 'string' ? sent.provider : null,
      messageId: typeof sent.messageId === 'string' ? sent.messageId : null,
      sentAt: timestampToIso(sent.sentAt),
      providerAcceptedAt: timestampToIso(sent.providerAcceptedAt || events.providerAcceptedAt),
      deliveredAt: timestampToIso(sent.deliveredAt || events.deliveredAt),
      bouncedAt: timestampToIso(sent.bouncedAt || events.bouncedAt),
      complainedAt: timestampToIso(sent.complainedAt || events.complainedAt),
      providerAccepted,
      delivered,
      bounces,
      complaints,
    };
  });
}
