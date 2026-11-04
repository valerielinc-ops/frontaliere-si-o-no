import { createHash } from 'node:crypto';
import { getServerRemoteConfigValue } from './remoteConfigSecrets.js';

// Read only from the firebase-server namespace. Do not add a client-template fallback.
export const META_CAPI_ACCESS_TOKEN_RC_KEY = 'SERVER_META_CAPI_ACCESS_TOKEN';

const META_PIXEL_ID = '1090503593451766';
const META_GRAPH_API_VERSION = 'v26.0';
const VALID_META_EVENT_SOURCE_URLS = new Set([
  'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/',
  'https://frontaliereticino.ch/cerca-lavoro-ticino/?application_concierge=1',
]);
const META_COOKIE_VALUE_RE = /^fb\.[0-9]{1,4}\.[0-9]{1,16}\.[A-Za-z0-9_-]{1,200}$/;
const VALID_CONCIERGE_AMOUNTS_CENTS = new Set([2999, 3999]);
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (value && typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (value instanceof Date) return value.getTime() || 0;
  return Number(value) || 0;
}

function validMetaCookie(value) {
  const result = boundedString(value, 250);
  return META_COOKIE_VALUE_RE.test(result) ? result : '';
}

export function validMetaEventSourceUrl(value) {
  const result = boundedString(value, 300);
  return VALID_META_EVENT_SOURCE_URLS.has(result) ? result : '';
}

export function hasCurrentMetaAdsConsent(service, consent) {
  const orderConsentAtMs = timestampMillis(service?.metaAdsConsentAt);
  const consentDecisionAtMs = Number(consent?.metaAdsConsentDecisionAtMs) || 0;
  const lastDeniedAtMs = Math.max(
    Number(consent?.metaAdsConsentLastDeniedAtMs) || 0,
    consent?.metaAdsConsent === false ? consentDecisionAtMs : 0,
  );
  return service?.metaAdsConsent === true
    && consent?.metaAdsConsent === true
    && orderConsentAtMs > 0
    && consentDecisionAtMs >= orderConsentAtMs
    && orderConsentAtMs > lastDeniedAtMs;
}

function skipped(reason) {
  return { payload: null, eventId: null, reason };
}

export function buildMetaPurchasePayload(serviceId, service, { nowMs = Date.now() } = {}) {
  if (service?.paymentStatus !== 'paid') return skipped('not_paid');
  if (service?.metaAdsConsent !== true) return skipped('not_consented');
  const eventSourceUrl = validMetaEventSourceUrl(service.metaEventSourceUrl);
  if (!eventSourceUrl) return skipped('missing_source_url');

  const fbp = validMetaCookie(service.metaFbp);
  const fbc = validMetaCookie(service.metaFbc);
  if (!fbp && !fbc) return skipped('missing_match_cookie');

  const amountCents = Number(service.amountTotal);
  const currency = String(service.currency || '').toLowerCase();
  if (!VALID_CONCIERGE_AMOUNTS_CENTS.has(amountCents) || currency !== 'eur') {
    return skipped('invalid_payment_value');
  }

  const paidAtMs = timestampMillis(service.paidAt);
  if (!paidAtMs || paidAtMs > nowMs || nowMs - paidAtMs > MAX_EVENT_AGE_MS) {
    return skipped('invalid_event_time');
  }

  const eventId = createHash('sha256')
    .update(`application-concierge-purchase:${boundedString(serviceId, 200)}`)
    .digest('hex');
  const value = amountCents / 100;
  return {
    eventId,
    reason: null,
    payload: {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(paidAtMs / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: eventSourceUrl,
        user_data: {
          ...(fbp ? { fbp } : {}),
          ...(fbc ? { fbc } : {}),
        },
        custom_data: {
          currency: 'EUR',
          value,
          content_type: 'product',
          content_ids: ['application-concierge-30d-10'],
          content_name: 'Servizio candidature assistite',
          num_items: 1,
          contents: [{ id: 'application-concierge-30d-10', quantity: 1, item_price: value }],
        },
      }],
    },
  };
}

export async function sendMetaCapiPurchase(
  serviceId,
  service,
  { readConfig = getServerRemoteConfigValue, fetchImpl = fetch, nowMs = Date.now(), beforeSend } = {},
) {
  const built = buildMetaPurchasePayload(serviceId, service, { nowMs });
  if (!built.payload) return { sent: false, reason: built.reason };

  const accessToken = boundedString(
    process.env.META_CAPI_ACCESS_TOKEN || await readConfig(META_CAPI_ACCESS_TOKEN_RC_KEY),
    4096,
  );
  if (!accessToken) throw new Error('meta_capi_access_token_missing');
  if (beforeSend && !await beforeSend()) return { sent: false, reason: 'consent_revoked' };

  const response = await fetchImpl(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PIXEL_ID}/events`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...built.payload, access_token: accessToken }),
    },
  );
  if (!response.ok) throw new Error('meta_capi_request_rejected');

  const responseBody = await response.json().catch(() => null);
  if (responseBody?.events_received !== 1) throw new Error('meta_capi_event_not_received');
  return { sent: true, eventId: built.eventId };
}
