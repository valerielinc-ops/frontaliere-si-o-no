import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  createCheckout: vi.fn(),
  retrieveCheckout: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__timestamp__' },
}));
vi.mock('../functions/src/stripePublisherCore.js', () => ({
  db: () => mocks.db(),
}));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(),
}));
vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 199,
  SUMUP_ENVIRONMENTS: { SANDBOX: 'sandbox' },
  createSumUpPaymentTestCheckout: (...args: unknown[]) => mocks.createCheckout(...args),
  retrieveSumUpCheckout: (...args: unknown[]) => mocks.retrieveCheckout(...args),
}));

const {
  handleCreateSumUpPaymentTestCheckout,
  handleGetSumUpPaymentTestStatus,
  handleSumUpPaymentTestWebhook,
} = await import('../functions/src/sumupPaymentTest.js');

function makeDb() {
  const documents = new Map<string, Record<string, unknown>>();
  const db = {
    collection: (name: string) => {
      expect(name).toBe('sumup_payment_tests');
      return {
        doc: (id: string) => ({
          async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
            const previous = documents.get(id) || {};
            documents.set(id, options?.merge ? { ...previous, ...data } : { ...data });
          },
          async get() {
            const data = documents.get(id);
            return {
              exists: Boolean(data),
              data: () => data,
            };
          },
        }),
      };
    },
  };
  return { db, documents };
}

beforeEach(() => {
  mocks.db.mockReset();
  mocks.createCheckout.mockReset();
  mocks.retrieveCheckout.mockReset();
});

describe('isolated SumUp sandbox payment test flow', () => {
  it('keeps the sandbox ledger separate and confirms a paid webhook', async () => {
    const firestore = makeDb();
    mocks.createCheckout.mockResolvedValue({ id: 'sandbox_checkout_1' });
    mocks.db.mockReturnValue(firestore.db);

    const created = await handleCreateSumUpPaymentTestCheckout({
      method: 'POST',
      headers: { origin: 'https://frontaliere-ticino.web.app' },
      body: {},
    }, {
      db: firestore.db,
      createCheckout: mocks.createCheckout,
    });

    expect(created.status).toBe(200);
    expect(created.body).toEqual(expect.objectContaining({
      ok: true,
      checkoutId: 'sandbox_checkout_1',
      amountCents: 199,
      currency: 'EUR',
    }));
    const testId = String(created.body.testId);
    expect(testId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firestore.documents.get(testId)).toEqual(expect.objectContaining({
      checkoutId: 'sandbox_checkout_1',
      checkoutStatus: 'PENDING',
      paymentStatus: 'pending',
    }));
    expect(mocks.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ testId }),
      expect.any(Function),
    );

    mocks.retrieveCheckout.mockResolvedValue({
      id: 'sandbox_checkout_1',
      checkout_reference: `google-pay-test-${testId}`,
      amount: 1.99,
      currency: 'EUR',
      status: 'PAID',
      transactions: [{ id: 'sandbox_transaction_1' }],
    });
    await expect(handleSumUpPaymentTestWebhook({
      method: 'POST',
      body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: 'sandbox_checkout_1' },
    }, {
      db: firestore.db,
      retrieve: mocks.retrieveCheckout,
    })).resolves.toEqual({
      status: 200,
      body: { received: true, paymentStatus: 'paid' },
    });
    expect(mocks.retrieveCheckout).toHaveBeenCalledWith(
      'sandbox_checkout_1',
      expect.any(Function),
      { environment: 'sandbox' },
    );
    expect(firestore.documents.get(testId)).toEqual(expect.objectContaining({
      providerStatus: 'PAID',
      paymentStatus: 'paid',
      amountValid: true,
      currencyValid: true,
      transactionId: 'sandbox_transaction_1',
    }));

    await expect(handleGetSumUpPaymentTestStatus({
      method: 'GET',
      headers: { origin: 'https://frontaliere-ticino.web.app' },
      query: { testId },
    }, { db: firestore.db })).resolves.toEqual(expect.objectContaining({
      status: 200,
      body: expect.objectContaining({
        testId,
        checkoutStatus: 'PAID',
        paymentStatus: 'paid',
        transactionId: 'sandbox_transaction_1',
      }),
    }));
  });

  it('allows the canonical production host for the isolated sandbox page', async () => {
    const firestore = makeDb();
    mocks.createCheckout.mockResolvedValue({ id: 'sandbox_checkout_canonical' });
    await expect(handleCreateSumUpPaymentTestCheckout({
      method: 'POST',
      headers: { origin: 'https://frontaliereticino.ch' },
      body: {},
    }, { db: firestore.db, createCheckout: mocks.createCheckout })).resolves.toEqual(expect.objectContaining({
      status: 200,
      body: expect.objectContaining({
        ok: true,
        checkoutId: 'sandbox_checkout_canonical',
      }),
    }));
  });

  it('rejects browser origins outside the dedicated staging and canonical hosts', async () => {
    await expect(handleCreateSumUpPaymentTestCheckout({
      method: 'POST',
      headers: { origin: 'https://unauthorized.example' },
      body: {},
    }, { db: makeDb().db, createCheckout: mocks.createCheckout })).resolves.toEqual({
      status: 403,
      body: { ok: false, error: 'test_origin_not_allowed' },
    });
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
});
