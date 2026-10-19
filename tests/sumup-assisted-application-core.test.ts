import { beforeEach, describe, expect, it, vi } from 'vitest';

const remoteConfig = vi.hoisted(() => vi.fn(async (key: string) => {
  const values: Record<string, string> = {
    ASSISTED_APPLICATION_PAYMENT_PROVIDER: 'sumup',
    SUMUP_API_KEY: 'sup_sk_test',
    SUMUP_MERCHANT_CODE: 'MC_TEST',
    SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL: 'https://europe-west6.example.test/sumupAssistedApplicationWebhook',
  };
  return values[key] || '';
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => remoteConfig(key),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const {
  createSumUpAssistedApplicationCheckout,
  createSumUpApplicationConciergeCheckout,
  getAssistedApplicationPaymentProvider,
  latestSumUpTransaction,
  refundSumUpTransaction,
  retrieveSumUpCheckout,
} = await import('../functions/src/sumupAssistedApplicationCore.js');

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  remoteConfig.mockImplementation(async (key: string) => {
    const values: Record<string, string> = {
      ASSISTED_APPLICATION_PAYMENT_PROVIDER: 'sumup',
      SUMUP_API_KEY: 'sup_sk_test',
      SUMUP_MERCHANT_CODE: 'MC_TEST',
      SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL: 'https://europe-west6.example.test/sumupAssistedApplicationWebhook',
    };
    return values[key] || '';
  });
  fetchMock.mockReset();
});
describe('SumUp assisted-application payment client', () => {
  it('selects the newest transaction by timestamp, not array position', () => {
    expect(latestSumUpTransaction({
      transactions: [
        { id: 'successful-retry', status: 'SUCCESSFUL', timestamp: '2026-10-12T12:22:48.309Z' },
        { id: 'failed-retry', status: 'FAILED', timestamp: '2026-10-12T12:22:15.638Z' },
        { id: 'failed-first', status: 'FAILED', timestamp: '2026-10-12T12:21:25.969Z' },
      ],
    })).toEqual(expect.objectContaining({
      id: 'successful-retry',
      status: 'SUCCESSFUL',
    }));
  });

  it('uses SumUp only when the payment-provider configuration explicitly selects it', async () => {
    expect(await getAssistedApplicationPaymentProvider()).toBe('sumup');
    remoteConfig.mockResolvedValue('');
    expect(await getAssistedApplicationPaymentProvider()).toBe('stripe');
  });

  it('keeps Stripe as the fallback while the SumUp Remote Config contract is incomplete', async () => {
    remoteConfig.mockImplementation(async (key: string) => ({
      ASSISTED_APPLICATION_PAYMENT_PROVIDER: 'sumup',
      SUMUP_API_KEY: 'sup_sk_test',
      SUMUP_MERCHANT_CODE: 'MC_TEST',
      SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL: '',
    }[key] || ''));

    await expect(getAssistedApplicationPaymentProvider()).resolves.toBe('stripe');
  });

  it('creates a 1.99 EUR widget checkout with a server-side status callback', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'sumup_checkout_1',
      }),
    });

    const result = await createSumUpAssistedApplicationCheckout({
      orderId: 'order-1',
      redirectUrl: 'https://frontaliereticino.ch/lavoro/job-42?assisted_application_order_id=order-1',
    });

    expect(result).toEqual({
      id: 'sumup_checkout_1',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sumup.com/v0.1/checkouts');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer sup_sk_test',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({
      amount: 1.99,
      checkout_reference: 'order-1',
      currency: 'EUR',
      description: 'Candidatura assistita',
      merchant_code: 'MC_TEST',
      redirect_url: 'https://frontaliereticino.ch/lavoro/job-42?assisted_application_order_id=order-1',
      return_url: 'https://europe-west6.example.test/sumupAssistedApplicationWebhook',
    });
  });

  it('creates a 39.99 EUR embedded concierge checkout without a hosted page', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'sumup_concierge_1',
      }),
    });

    await expect(createSumUpApplicationConciergeCheckout({
      serviceId: 'concierge-1',
      redirectUrl: 'https://frontaliereticino.ch/concierge?order=concierge-1',
    })).resolves.toEqual({
      id: 'sumup_concierge_1',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      amount: 39.99,
      checkout_reference: 'concierge-1',
      currency: 'EUR',
      description: 'Servizio candidature assistite',
      redirect_url: 'https://frontaliereticino.ch/concierge?order=concierge-1',
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('hosted_checkout');
  });

  it('re-fetches a checkout and supports full refunds through the SumUp API', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'sumup_checkout_1', status: 'PAID' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(retrieveSumUpCheckout('sumup_checkout_1')).resolves.toEqual({
      id: 'sumup_checkout_1',
      status: 'PAID',
    });
    await expect(refundSumUpTransaction('sumup_transaction_1')).resolves.toEqual({ status: 204 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sumup.com/v0.1/checkouts/sumup_checkout_1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.sumup.com/v0.1/me/refund/sumup_transaction_1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer sup_sk_test' },
    });
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it('recovers the existing checkout when SumUp rejects a duplicate reference', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error_code: 'DUPLICATED_CHECKOUT' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ([{
        checkout_reference: 'order-1',
        amount: 1.99,
        currency: 'EUR',
        id: 'sumup_checkout_existing',
        status: 'PENDING',
      }]) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        id: 'sumup_checkout_existing',
        status: 'PENDING',
      }) });

    await expect(createSumUpAssistedApplicationCheckout({
      orderId: 'order-1',
      redirectUrl: 'https://frontaliereticino.ch/lavoro/job-42',
    })).resolves.toEqual({
      id: 'sumup_checkout_existing',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.sumup.com/v0.1/checkouts?checkout_reference=order-1');
  });

  it('fails closed when SumUp credentials are incomplete', async () => {
    remoteConfig.mockImplementation(async (key: string) => (key === 'SUMUP_API_KEY' ? 'sup_sk_test' : ''));
    await expect(createSumUpAssistedApplicationCheckout({
      orderId: 'order-1',
      redirectUrl: 'https://frontaliereticino.ch/lavoro/job-42',
    })).rejects.toThrow('sumup_credentials_missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
