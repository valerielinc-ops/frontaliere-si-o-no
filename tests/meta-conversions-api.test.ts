import { describe, expect, it, vi } from 'vitest';

const { getServerRemoteConfigValueMock } = vi.hoisted(() => ({
  getServerRemoteConfigValueMock: vi.fn(async () => 'server-template-capi-token'),
}));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getServerRemoteConfigValue: (...args: unknown[]) => getServerRemoteConfigValueMock(...args),
}));

import {
  buildMetaPurchasePayload,
  hasCurrentMetaAdsConsent,
  META_CAPI_ACCESS_TOKEN_RC_KEY,
  sendMetaCapiPurchase,
} from '../functions/src/metaConversionsApi.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);
const PAID_AT_MS = NOW_MS - 30_000;

function paidService(overrides: Record<string, unknown> = {}) {
  return {
    paymentStatus: 'paid',
    metaAdsConsent: true,
    metaAdsConsentAt: { toMillis: () => PAID_AT_MS - 1000 },
    metaEventSourceUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?application_concierge=1',
    metaFbp: 'fb.1.1700000000000.1234567890',
    metaFbc: 'fb.1.1700000000000.ABC_def-123',
    amountTotal: 3999,
    currency: 'eur',
    paidAt: { toMillis: () => PAID_AT_MS },
    ...overrides,
  };
}

describe('Meta Conversions API Purchase events', () => {
  it('reads the token from the server-only Remote Config parameter', () => {
    expect(META_CAPI_ACCESS_TOKEN_RC_KEY).toBe('SERVER_META_CAPI_ACCESS_TOKEN');
  });

  it('uses the private server-template reader by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ events_received: 1 }),
    }) as unknown as typeof fetch;

    await sendMetaCapiPurchase('service-42', paidService(), {
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(getServerRemoteConfigValueMock).toHaveBeenCalledWith('SERVER_META_CAPI_ACCESS_TOKEN');
    const [, options] = vi.mocked(fetchImpl).mock.calls[0];
    expect(JSON.parse(String(options?.body)).access_token).toBe('server-template-capi-token');
  });

  it('builds a pseudonymous Purchase event from a consented verified payment', () => {
    const built = buildMetaPurchasePayload('service-42', paidService(), { nowMs: NOW_MS });
    const event = built.payload?.data[0];

    expect(event).toEqual(expect.objectContaining({
      event_name: 'Purchase',
      event_time: Math.floor(PAID_AT_MS / 1000),
      action_source: 'website',
      event_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?application_concierge=1',
      custom_data: expect.objectContaining({ currency: 'EUR', value: 39.99 }),
    }));
    expect(built.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(event?.event_id).toBe(built.eventId);
    expect(event?.user_data).toEqual({
      fbp: 'fb.1.1700000000000.1234567890',
      fbc: 'fb.1.1700000000000.ABC_def-123',
    });
    expect(event?.user_data).not.toHaveProperty('em');
    expect(event?.user_data).not.toHaveProperty('ph');
    expect(event?.user_data).not.toHaveProperty('client_ip_address');
  });

  it.each([
    ['without advertising consent', { metaAdsConsent: false }, 'not_consented'],
    ['without Meta attribution cookies', { metaFbp: null, metaFbc: null }, 'missing_match_cookie'],
    ['before payment confirmation', { paymentStatus: 'pending' }, 'not_paid'],
    ['with an unsupported payment amount', { amountTotal: 100 }, 'invalid_payment_value'],
    ['without an allowlisted source page', { metaEventSourceUrl: 'https://attacker.example/' }, 'missing_source_url'],
  ])('does not build a Purchase event %s', (_label, overrides, reason) => {
    expect(buildMetaPurchasePayload('service-42', paidService(overrides), { nowMs: NOW_MS }))
      .toEqual({ payload: null, eventId: null, reason });
  });

  it('rejects an order consented before a revocation and accepts a fresh consented order', () => {
    const deniedAt = NOW_MS - 20_000;
    const latestGrantAt = NOW_MS - 10_000;
    const currentConsent = {
      metaAdsConsent: true,
      metaAdsConsentDecisionAtMs: latestGrantAt,
      metaAdsConsentLastDeniedAtMs: deniedAt,
    };

    expect(hasCurrentMetaAdsConsent(paidService({
      metaAdsConsentAt: { toMillis: () => deniedAt - 1 },
    }), currentConsent)).toBe(false);
    expect(hasCurrentMetaAdsConsent(paidService({
      metaAdsConsentAt: { toMillis: () => latestGrantAt },
    }), currentConsent)).toBe(true);
  });

  it('sends the server event to the configured Pixel and requires Meta to accept one event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ events_received: 1 }),
    }) as unknown as typeof fetch;
    const result = await sendMetaCapiPurchase('service-42', paidService(), {
      readConfig: vi.fn(async () => 'test-capi-token'),
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ sent: true, eventId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v26.0/1090503593451766/events');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const requestBody = JSON.parse(String(options?.body));
    expect(requestBody.access_token).toBe('test-capi-token');
    expect(requestBody.data).toHaveLength(1);
    expect(String(url)).not.toContain('test-capi-token');
  });

  it('does not call Meta when the Pixel cannot match the consented browser', async () => {
    const readConfig = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await sendMetaCapiPurchase('service-42', paidService({ metaFbp: null, metaFbc: null }), {
      readConfig,
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ sent: false, reason: 'missing_match_cookie' });
    expect(readConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks current consent immediately before sending the server event', async () => {
    const readConfig = vi.fn(async () => 'test-capi-token');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await sendMetaCapiPurchase('service-42', paidService(), {
      readConfig,
      fetchImpl,
      nowMs: NOW_MS,
      beforeSend: vi.fn(async () => false),
    });

    expect(result).toEqual({ sent: false, reason: 'consent_revoked' });
    expect(readConfig).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on non-accepted Meta responses so the payment event can be retried', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ events_received: 0 }),
    }) as unknown as typeof fetch;

    await expect(sendMetaCapiPurchase('service-42', paidService(), {
      readConfig: vi.fn(async () => 'test-capi-token'),
      fetchImpl,
      nowMs: NOW_MS,
    })).rejects.toThrow('meta_capi_event_not_received');
  });
});
