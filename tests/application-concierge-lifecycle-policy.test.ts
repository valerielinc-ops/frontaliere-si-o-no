import { describe, expect, it } from 'vitest';
import { APPLICATION_CONCIERGE_MATCHING_VERSION } from '../functions/src/applicationConciergeConstants.js';
import { CONCIERGE_DAY_MS as DAY, CONCIERGE_FRESH_PENDING_INTERVAL_MS, CONCIERGE_RETRY_INTERVAL_MS,
  CONCIERGE_MATCHING_VERSION_SETTLE_MS, CONCIERGE_STALE_RECOVERY_BACKOFF_MS, CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
  conciergeMatchingRecoveryContext, conciergeMatchingVersionRefreshReady, conciergeRefreshDue, conciergeRenewalOffer,
  conciergeStaleRecoveryExhausted } from '../functions/src/applicationConciergeLifecyclePolicy.js';

const now = Date.now();
function active(overrides = {}) {
  return { paymentStatus: 'paid', serviceStatus: 'active', cvStorageKey: 'private/cv.pdf', consentedAt: now - 4 * DAY,
    expiresAt: now + DAY, paidAt: now - 29 * DAY, matchingCompletedAt: now - 3 * DAY,
    acceptedPositionsCount: 2, maxPositions: 10, matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION, ...overrides };
}

describe('three-day proposal refresh', () => {
  it('waits for the observed matcher version to settle before a rollout refresh', () => {
    const legacy = active({ matchingStatus: 'complete', matchingVersion: 'legacy-version', matchingCompletedAt: now });
    expect(conciergeMatchingVersionRefreshReady(legacy, now)).toBe(false);
    expect(conciergeMatchingVersionRefreshReady({ ...legacy,
      matchingVersionRefreshVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingVersionRefreshObservedAt: now }, now + CONCIERGE_MATCHING_VERSION_SETTLE_MS - 1)).toBe(false);
    expect(conciergeMatchingVersionRefreshReady({ ...legacy,
      matchingVersionRefreshVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingVersionRefreshObservedAt: now }, now + CONCIERGE_MATCHING_VERSION_SETTLE_MS)).toBe(true);
  });

  it('revalidates legacy proposals immediately while retaining cap, expiry and active-run guards', () => {
    const legacy = active({ matchingStatus: 'complete', matchingVersion: 'legacy-version', matchingCompletedAt: now });
    expect(conciergeRefreshDue(legacy, now)).toBe(true);
    expect(conciergeRefreshDue({ ...legacy, matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...legacy, acceptedPositionsCount: 10, maxPositions: 20 }, now)).toBe(false);
    for (const patch of [{ acceptedPositionsCount: 10 }, { expiresAt: now }, { consentedAt: null }, { paymentStatus: 'refunded' }]) {
      expect(conciergeRefreshDue({ ...legacy, ...patch }, now)).toBe(false);
    }
    expect(conciergeRefreshDue({ ...legacy, matchingStatus: 'running', matchingStartedAt: now - 60_000 }, now)).toBe(false);
  });

  it('treats a queued event refresh as due even before the normal interval', () => {
    const queued = active({ matchingStatus: 'complete', matchingCompletedAt: now,
      matchingEventRefreshRequestedAt: now });
    expect(conciergeRefreshDue(queued, now)).toBe(true);
    expect(conciergeRefreshDue({ ...queued, matchingStatus: 'failed', matchingStaleRecoveryRetryAt: now + DAY }, now)).toBe(true);
  });

  it('runs at the interval only for eligible services', () => {
    expect(conciergeRefreshDue(active(), now)).toBe(true);
    for (const patch of [{ acceptedPositionsCount: 10 }, { expiresAt: now }, { paymentStatus: 'refunded' },
      { matchingCompletedAt: now - 3 * DAY + 1 }, { cvStorageKey: '' }, { consentedAt: null }, { matchingStatus: 'running' }]) {
      expect(conciergeRefreshDue(active(patch), now)).toBe(false);
    }
  });

  it('schedules persisted legacy recovery at its bounded retry time and stops at the cap', () => {
    const pending = active({ matchingStatus: 'complete', matchingCompletedAt: now,
      matchingLegacyRecoveryPendingCount: 4, matchingLegacyRecoveryRetryAt: now + 60 * 60 * 1000 });
    expect(conciergeRefreshDue(pending, now)).toBe(false);
    expect(conciergeRefreshDue(pending, now + 60 * 60 * 1000)).toBe(true);
    expect(conciergeRefreshDue({ ...pending, matchingLegacyRecoveryPendingCount: 0 }, now + 60 * 60 * 1000)).toBe(false);
    expect(conciergeRefreshDue({ ...pending, acceptedPositionsCount: 10 }, now + DAY)).toBe(false);
    expect(conciergeRefreshDue({ ...pending, matchingStatus: 'failed', matchingLegacyRecoveryRetryAt: now + 3 * DAY }, now + 60 * 60 * 1000)).toBe(true);
  });

  it('continues the general scan while legacy recovery remains in backoff', () => {
    const pending = active({ matchingStatus: 'complete', matchingCompletedAt: now - 2 * 60 * 60 * 1000,
      matchingPendingCount: 263, matchingUnverifiedCount: 157,
      matchingLegacyRecoveryPendingCount: 5, matchingLegacyRecoveryRetryAt: now + 3 * 60 * 60 * 1000 });
    expect(conciergeRefreshDue(pending, now)).toBe(true);
  });

  it('refreshes fresh pending work at the exact 15-minute boundary but keeps retry-only work hourly', () => {
    const pending = active({ matchingStatus: 'complete', matchingCompletedAt: now,
      matchingPendingCount: 203, matchingUnverifiedCount: 172, matchingRetryAt: now + 12 * DAY,
      matchingLegacyRecoveryPendingCount: 5, matchingLegacyRecoveryRetryAt: now + 3 * DAY });
    expect(conciergeRefreshDue(pending, now + CONCIERGE_FRESH_PENDING_INTERVAL_MS - 1)).toBe(false);
    expect(conciergeRefreshDue(pending, now + CONCIERGE_FRESH_PENDING_INTERVAL_MS)).toBe(true);

    const retryOnly = active({ matchingStatus: 'complete', matchingCompletedAt: now,
      matchingPendingCount: 0, matchingUnverifiedCount: 172, matchingRetryAt: 0 });
    expect(conciergeRefreshDue(retryOnly, now + CONCIERGE_RETRY_INTERVAL_MS - 1)).toBe(false);
    expect(conciergeRefreshDue(retryOnly, now + CONCIERGE_RETRY_INTERVAL_MS)).toBe(true);

    const failedPending = { ...pending, matchingStatus: 'failed' };
    expect(conciergeRefreshDue(failedPending, now + CONCIERGE_FRESH_PENDING_INTERVAL_MS - 1)).toBe(false);
    expect(conciergeRefreshDue(failedPending, now + CONCIERGE_FRESH_PENDING_INTERVAL_MS)).toBe(true);

    const failedRetryOnly = { ...failedPending, matchingPendingCount: 0 };
    expect(conciergeRefreshDue(failedRetryOnly, now + CONCIERGE_RETRY_INTERVAL_MS - 1)).toBe(false);
    expect(conciergeRefreshDue(failedRetryOnly, now + CONCIERGE_RETRY_INTERVAL_MS)).toBe(true);
  });

  it('leaves unchanged exhausted eligibility unknown and returns to the normal three-day discovery cadence', () => {
    const exhaustedOnly = active({ matchingStatus: 'complete', matchingCompletedAt: now,
      matchingPendingCount: 0, matchingUnverifiedCount: 20, matchingRetryCount: 0,
      matchingRetryExhaustedCount: 20, matchingRetryAt: null, expiresAt: now + 4 * DAY });
    expect(conciergeRefreshDue(exhaustedOnly, now + CONCIERGE_RETRY_INTERVAL_MS)).toBe(false);
    expect(conciergeRefreshDue(exhaustedOnly, now + 3 * DAY - 1)).toBe(false);
    expect(conciergeRefreshDue(exhaustedOnly, now + 3 * DAY)).toBe(true);
  });

  it('backs off and stops automatic retries after repeated whole-matcher failures', () => {
    const failed = active({ matchingStatus: 'failed', matchingCompletedAt: now, matchingError: 'job_search_failed' });
    const context = conciergeMatchingRecoveryContext(failed);
    const retry = { ...failed, matchingStaleRecoveryContext: context, matchingStaleRecoveryAttempt: 1,
      matchingStaleRecoveryRetryAt: now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS[0] };
    expect(conciergeRefreshDue(retry, now)).toBe(false);
    expect(conciergeRefreshDue(retry, now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS[0])).toBe(true);

    const exhausted = { ...retry, matchingStaleRecoveryAttempt: CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
      matchingStaleRecoveryRetryAt: now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS.at(-1) };
    expect(conciergeRefreshDue(exhausted, now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS.at(-1))).toBe(false);
    expect(conciergeStaleRecoveryExhausted(exhausted, now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS.at(-1))).toBe(true);
  });
});

it('recovers a stale matching run only after the bounded lease', () => {
  expect(conciergeRefreshDue(active({ matchingStatus: 'running', matchingStartedAt: now - 11 * 60 * 1000, matchingCompletedAt: now }), now)).toBe(true);
  expect(conciergeRefreshDue(active({ matchingStatus: 'running', matchingStartedAt: now - 5 * 60 * 1000 }), now)).toBe(false);
});

describe('three-day renewal discount', () => {
  it('uses the original expiry as a fixed deadline, including exact boundaries', () => {
    const service = active({ expiresAt: now });
    expect(conciergeRenewalOffer(service, now - 1)).toBeNull();
    expect(conciergeRenewalOffer(service, now)).toMatchObject({ amountTotal: 2999, reminderStage: 0, discountExpiresAt: now + 3 * DAY });
    expect(conciergeRenewalOffer(service, now + DAY)).toMatchObject({ amountTotal: 2999, reminderStage: 1 });
    expect(conciergeRenewalOffer(service, now + 3 * DAY - 1)).toMatchObject({ amountTotal: 2999, reminderStage: 2 });
    expect(conciergeRenewalOffer(service, now + 3 * DAY)).toMatchObject({ amountTotal: 3999, discounted: false, reminderStage: null });
  });
  it('stops reminders and offers after a renewal or refund', () => {
    expect(conciergeRenewalOffer(active({ expiresAt: now, renewedByServiceId: 'renewal-example' }), now)).toBeNull();
    expect(conciergeRenewalOffer(active({ expiresAt: now, paymentStatus: 'refunded' }), now)).toBeNull();
  });
});
