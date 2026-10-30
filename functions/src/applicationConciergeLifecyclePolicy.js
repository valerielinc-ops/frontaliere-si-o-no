/** Shared server policy for refresh cadence and the time-limited renewal offer. */
import {
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_MATCHING_VERSION,
  APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
  acceptedPositionsCount,
  serviceIsActive,
  timestampMillis,
} from './applicationConciergeConstants.js';

export const CONCIERGE_DAY_MS = 24 * 60 * 60 * 1000;
export const CONCIERGE_REFRESH_INTERVAL_MS = 3 * CONCIERGE_DAY_MS;
export const CONCIERGE_RENEWAL_DISCOUNT_MS = 3 * CONCIERGE_DAY_MS;
export const CONCIERGE_RENEWAL_PRICE_EUR_CENTS = 2999;

export function conciergeRefreshDue(service, nowMs = Date.now()) {
  if (!serviceIsActive(service, nowMs) || !service.cvStorageKey || !service.consentedAt) return false;
  const cap = Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS;
  if (acceptedPositionsCount(service) >= cap) return false;
  if (service.matchingStatus === 'running') {
    const started = timestampMillis(service.matchingStartedAt);
    return started > 0 && nowMs - started >= 10 * 60 * 1000;
  }
  // Revalidate existing proposals after an eligibility upgrade without asking the owner to re-upload a CV.
  if (service.matchingStatus === 'complete' && service.matchingVersion !== APPLICATION_CONCIERGE_MATCHING_VERSION) return true;
  const lastRefresh = timestampMillis(service.matchingCompletedAt)
    || timestampMillis(service.cvUploadedAt) || timestampMillis(service.paidAt);
  if (Number(service.matchingUnverifiedCount) > 0 && Number(service.matchingPendingCount || 0) === 0 && service.matchingStatus !== 'failed') {
    const retryAt = timestampMillis(service.matchingRetryAt);
    if (retryAt) return nowMs >= Math.min(lastRefresh + CONCIERGE_REFRESH_INTERVAL_MS, retryAt);
  }
  const interval = service.matchingStatus === 'failed' || Number(service.matchingUnverifiedCount) > 0 || Number(service.matchingPendingCount) > 0 ? 60 * 60 * 1000 : CONCIERGE_REFRESH_INTERVAL_MS;
  return lastRefresh > 0 && nowMs >= lastRefresh + interval;
}

/** Eligibility and price are computed from the source purchase, never a client-supplied amount. */
export function conciergeRenewalOffer(service, nowMs = Date.now()) {
  const expiresAt = timestampMillis(service?.expiresAt);
  if (service?.paymentStatus !== 'paid' || !['active', 'expired'].includes(service.serviceStatus) || !expiresAt || nowMs < expiresAt || service.renewedByServiceId) return null;
  const discountExpiresAt = expiresAt + CONCIERGE_RENEWAL_DISCOUNT_MS;
  const discounted = nowMs < discountExpiresAt;
  return {
    amountTotal: discounted ? CONCIERGE_RENEWAL_PRICE_EUR_CENTS : APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
    currency: 'eur',
    discounted,
    discountExpiresAt,
    // A delayed scheduler sends only today's reminder, not a burst of older reminders.
    reminderStage: discounted ? Math.floor((nowMs - expiresAt) / CONCIERGE_DAY_MS) : null,
  };
}
