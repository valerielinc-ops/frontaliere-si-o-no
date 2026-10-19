/**
 * Contract for the 30-day application concierge.
 *
 * The concierge is a parent service with candidate-approved child
 * applications.  Keeping its vocabulary separate from the €1.99 one-off
 * order prevents the existing single-job flow from accidentally treating the
 * bundle as a subscription or as ten independent payments.
 */

export const APPLICATION_CONCIERGE_SERVICES_COLLECTION = 'application_concierge_services';
export const APPLICATION_CONCIERGE_PRODUCT = 'application_concierge';
export const APPLICATION_CONCIERGE_PRICE_EUR_CENTS = 3999;
export const APPLICATION_CONCIERGE_CURRENCY = 'eur';
export const APPLICATION_CONCIERGE_DURATION_DAYS = 30;
export const APPLICATION_CONCIERGE_MAX_POSITIONS = 10;
export const APPLICATION_CONCIERGE_CONSENT_VERSION = 'application-concierge-v1';
export const APPLICATION_CONCIERGE_CV_PREFIX = 'application-concierge-uploads';

export const APPLICATION_CONCIERGE_SERVICE_STATUSES = Object.freeze([
  'awaiting_payment',
  'active',
  'expired',
  'payment_failed',
  'refunded',
]);

export const APPLICATION_CONCIERGE_PROPOSAL_STATUSES = Object.freeze([
  'proposed',
  'accepted',
  'declined',
  'expired',
  'retracted',
]);

export function timestampMillis(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === 'function') return Number(value.toMillis()) || 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime() || 0;
  if (value instanceof Date) return value.getTime() || 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function serviceIsActive(service, nowMs = Date.now()) {
  const expiresAt = timestampMillis(service?.expiresAt);
  return service?.paymentStatus === 'paid'
    && service?.serviceStatus === 'active'
    && expiresAt > Number(nowMs);
}

export function serviceIsExpired(service, nowMs = Date.now()) {
  const expiresAt = timestampMillis(service?.expiresAt);
  return service?.serviceStatus === 'expired'
    || (expiresAt > 0 && expiresAt <= Number(nowMs));
}

export function acceptedPositionsCount(service) {
  const value = Number(service?.acceptedPositionsCount);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
