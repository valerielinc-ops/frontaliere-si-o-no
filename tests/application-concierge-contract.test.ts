import { describe, expect, it } from 'vitest';
import {
  APPLICATION_CONCIERGE_CONSENT_VERSION,
  APPLICATION_CONCIERGE_DURATION_DAYS,
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_PRICE_EUR_CENTS,
  APPLICATION_CONCIERGE_PRODUCT,
  acceptedPositionsCount,
  serviceIsActive,
  serviceIsExpired,
} from '../functions/src/applicationConciergeConstants.js';

describe('application concierge contract', () => {
  it('keeps the paid service bounded and non-renewing', () => {
    expect(APPLICATION_CONCIERGE_PRODUCT).toBe('application_concierge');
    expect(APPLICATION_CONCIERGE_PRICE_EUR_CENTS).toBe(3999);
    expect(APPLICATION_CONCIERGE_DURATION_DAYS).toBe(30);
    expect(APPLICATION_CONCIERGE_MAX_POSITIONS).toBe(10);
    expect(APPLICATION_CONCIERGE_CONSENT_VERSION).toBe('application-concierge-v1');
  });

  it('is active only while payment is paid and expiry is in the future', () => {
    const now = 1_700_000_000_000;
    const service = {
      paymentStatus: 'paid',
      serviceStatus: 'active',
      expiresAt: new Date(now + 1),
    };

    expect(serviceIsActive(service, now)).toBe(true);
    expect(serviceIsActive(service, now + 1)).toBe(false);
    expect(serviceIsExpired(service, now + 1)).toBe(true);
  });

  it('normalizes invalid accepted-position counters to zero', () => {
    expect(acceptedPositionsCount({ acceptedPositionsCount: 4 })).toBe(4);
    expect(acceptedPositionsCount({ acceptedPositionsCount: -1 })).toBe(0);
    expect(acceptedPositionsCount({ acceptedPositionsCount: 'not-a-number' })).toBe(0);
  });
});
