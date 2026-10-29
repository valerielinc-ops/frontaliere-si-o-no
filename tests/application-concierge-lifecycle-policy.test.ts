import { describe, expect, it } from 'vitest';
import { CONCIERGE_DAY_MS as DAY, conciergeRefreshDue, conciergeRenewalOffer } from '../functions/src/applicationConciergeLifecyclePolicy.js';

const now = Date.now();
function active(overrides = {}) {
  return { paymentStatus: 'paid', serviceStatus: 'active', cvStorageKey: 'private/cv.pdf', consentedAt: now - 4 * DAY,
    expiresAt: now + DAY, paidAt: now - 29 * DAY, matchingCompletedAt: now - 3 * DAY,
    acceptedPositionsCount: 2, maxPositions: 10, ...overrides };
}

describe('three-day proposal refresh', () => {
  it('runs at the interval only for eligible services', () => {
    expect(conciergeRefreshDue(active(), now)).toBe(true);
    for (const patch of [{ acceptedPositionsCount: 10 }, { expiresAt: now }, { paymentStatus: 'refunded' },
      { matchingCompletedAt: now - 3 * DAY + 1 }, { cvStorageKey: '' }, { consentedAt: null }, { matchingStatus: 'running' }]) {
      expect(conciergeRefreshDue(active(patch), now)).toBe(false);
    }
  });
});

it('recovers a stale matching run only after the bounded lease', () => {
  expect(conciergeRefreshDue(active({ matchingStatus: 'running', matchingStartedAt: now - 11 * 60 * 1000 }), now)).toBe(true);
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
