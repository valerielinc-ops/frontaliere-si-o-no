// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createApplicationConciergeCheckout,
  syncApplicationConciergeMetaConsent,
} from '@/services/applicationConciergeCheckout';

describe('createApplicationConciergeCheckout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reuses a random browser revocation token in authenticated checkout requests', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, serviceId: 'service-1', url: 'https://checkout.stripe.com/session-1' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const user = { uid: 'candidate-42', getIdToken: vi.fn(async () => 'firebase-token') };
    const input = {
      successUrl: 'https://frontaliereticino.ch/lavoro',
      cancelUrl: 'https://frontaliereticino.ch/lavoro',
      locale: 'it' as const,
    };

    await createApplicationConciergeCheckout(input, user);
    await createApplicationConciergeCheckout(input, user);

    const firstBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(firstBody.metaConsentRevocationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(secondBody.metaConsentRevocationToken).toBe(firstBody.metaConsentRevocationToken);
  });

  it('does not persist a consent timestamp that rounds down to zero', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user = { uid: 'candidate-42', getIdToken: vi.fn(async () => 'firebase-token') };

    await syncApplicationConciergeMetaConsent(user, 'granted', 0.5);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('frontaliere_meta_ads_consent_pending')).toBeNull();
  });
});
