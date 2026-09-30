/**
 * Opens and clicks of the e-mails the candidate receives about an assisted
 * application (owner request 2026-09-30): the admin panel shows, per e-mail,
 * whether it arrived, was opened and whether a link in it was clicked.
 *
 * Each send is tagged `type=assisted-application` with a campaign id naming the
 * order and the notification key (`aa--{orderId}--{key}`). The four provider
 * webhooks recognise that campaign before anything else and record the event
 * on the order: it never reaches the newsletter engagement of the address, nor
 * the job ranking clicks. Maileroo reports opens and clicks with neither the
 * recipient nor the tags, so its sends also write the usual reference record
 * (functions/src/lib/mailerooRef.js), which carries the campaign id.
 *
 * Opens are indicative: Apple Mail and some corporate filters open every
 * message on delivery.
 */

import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { makeMailerooRefOnSent } from './lib/mailerooRef.js';

export const ASSISTED_EMAIL_TYPE = 'assisted-application';
export const EMAIL_EVENTS_SUBCOLLECTION = 'email_events';
const CAMPAIGN_RE = /^aa--([A-Za-z0-9_-]{1,64}?)--([a-z0-9_]{1,60})$/;
const COUNTERS = { delivered: 'delivered', open: 'opens', click: 'clicks', bounce: 'bounces', complaint: 'complaints' };
const LAST_AT = { delivered: 'deliveredAt', open: 'lastOpenAt', click: 'lastClickAt', bounce: 'bouncedAt', complaint: 'complainedAt' };

/** `aa--{orderId}--{key}`: Resend tag values allow letters, digits, `_` and `-` only. */
export function assistedCampaignId(orderId, key) {
  const order = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const name = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  return `aa--${order}--${name}`;
}

/** @returns {{orderId:string, key:string}|null} */
export function parseAssistedCampaign(value) {
  const match = CAMPAIGN_RE.exec(String(value || ''));
  return match ? { orderId: match[1], key: match[2] } : null;
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
 * Record one provider event for a candidate e-mail. Webhooks are delivered at
 * least once: one document per provider event, and the counters on the order
 * move only when that document is new.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{campaign:string, type:string, provider:string, messageId?:string, occurredAt?:string|Date, url?:string}} event
 * @returns {Promise<{assisted:true, recorded:boolean, reason?:string}>}
 */
export async function recordAssistedEmailEvent(db, { campaign, type, provider, messageId = '', occurredAt, url = '' }) {
  const target = parseAssistedCampaign(campaign);
  if (!target) return { assisted: true, recorded: false, reason: 'unknown_campaign' };
  if (!COUNTERS[type]) return { assisted: true, recorded: false, reason: `untracked_type:${type}` };
  const at = eventDate(occurredAt);
  const link = type === 'click' ? linkWithoutQuery(url) : '';
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(target.orderId);
  const order = await orderRef.get();
  if (!order.exists) return { assisted: true, recorded: false, reason: 'order_not_found' };

  const eventId = createHash('sha256')
    .update([provider, messageId, type, at.toISOString(), link].join('|'))
    .digest('hex')
    .slice(0, 40);
  try {
    await orderRef.collection(EMAIL_EVENTS_SUBCOLLECTION).doc(eventId).create({
      key: target.key,
      type,
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
    [`${base}.${COUNTERS[type]}`]: FieldValue.increment(1),
    [`${base}.${LAST_AT[type]}`]: at,
  };
  if (type === 'open' && !order.get(`${base}.firstOpenAt`)) update[`${base}.firstOpenAt`] = at;
  if (link) update[`${base}.lastClickUrl`] = link;
  await orderRef.update(update);
  return { assisted: true, recorded: true };
}
