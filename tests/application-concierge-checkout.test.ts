import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  let sequence = 0;

  function key(collection: string, id: string) {
    return collection + '/' + id;
  }

  function makeRef(collection: string, id: string) {
    return {
      id,
      async get() {
        const data = store.get(key(collection, id));
        return { id, exists: Boolean(data), data: () => data };
      },
      async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        const current = store.get(key(collection, id)) || {};
        store.set(key(collection, id), options?.merge ? { ...current, ...data } : data);
      },
    };
  }

  const firestore = {
    collection(collection: string) {
      return {
        doc(id?: string) {
          return makeRef(collection, id || collection + '-' + (++sequence));
        },
      };
    },
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => ref.set(data, options),
        update: (ref: any, data: Record<string, unknown>) => ref.set(data, { merge: true }),
      });
    },
  };

  const stripeCheckoutSessionsCreate = vi.fn();
  const stripeCheckoutSessionsRetrieve = vi.fn();
  const createSumUpApplicationConciergeCheckout = vi.fn();
  const stripe = { checkout: { sessions: { create: stripeCheckoutSessionsCreate, retrieve: stripeCheckoutSessionsRetrieve } } };
  return {
    store,
    firestore,
    db: vi.fn(() => firestore),
    getStripe: vi.fn(async () => stripe),
    verifyCaller: vi.fn(async () => ({ uid: 'candidate-42', email: 'candidate@example.test' })),
    applySumUpCheckout: vi.fn(async (checkout: { checkout_reference: string }) => {
      const key = 'application_concierge_services/' + checkout.checkout_reference;
      store.set(key, { ...store.get(key), paymentStatus: 'paid' });
    }),
    retrieveSumUpCheckout: vi.fn(),
    getAssistedApplicationPaymentProvider: vi.fn(async () => 'stripe'),
    createSumUpHostedCheckout: vi.fn(),
    createSumUpApplicationConciergeCheckout,
    stripeCheckoutSessionsCreate,
    stripeCheckoutSessionsRetrieve,
    reset() {
      store.clear();
      sequence = 0;
      stripeCheckoutSessionsCreate.mockReset();
      stripeCheckoutSessionsRetrieve.mockReset();
      createSumUpApplicationConciergeCheckout.mockReset();
    },
  };
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    delete: () => '__delete_field__',
  },
  Timestamp: {
    fromMillis: (millis: number) => ({
      toMillis: () => millis,
      toDate: () => new Date(millis),
    }),
    now: () => ({
      toMillis: () => Date.now(),
      toDate: () => new Date(),
    }),
  },
}));

vi.mock('../functions/src/stripePublisherCore.js', () => ({
  db: mocks.db,
  getStripe: mocks.getStripe,
  verifyCaller: mocks.verifyCaller,
}));

vi.mock('../functions/src/assistedApplicationSumupWebhook.js', () => ({
  applyAssistedApplicationSumUpCheckout: mocks.applySumUpCheckout,
}));

vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  SUMUP_PAYMENT_PROVIDER: 'sumup',
  retrieveSumUpCheckout: mocks.retrieveSumUpCheckout,
  getAssistedApplicationPaymentProvider: mocks.getAssistedApplicationPaymentProvider,
  createSumUpHostedCheckout: mocks.createSumUpHostedCheckout,
  createSumUpApplicationConciergeCheckout: mocks.createSumUpApplicationConciergeCheckout,
}));

const {
  handleApplicationConciergeWebhookEvent,
  handleCreateApplicationConciergeCheckout,
} = await import('../functions/src/applicationConciergeCheckout.js');

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: {
      requestKey: 'concierge-request-key-42',
      locale: 'it',
      successUrl: 'https://frontaliereticino.ch/lavoro',
      cancelUrl: 'https://frontaliereticino.ch/lavoro',
    },
    get: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer good-token' : ''),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.verifyCaller.mockResolvedValue({ uid: 'candidate-42', email: 'candidate@example.test' });
  mocks.getAssistedApplicationPaymentProvider.mockResolvedValue('stripe');
  mocks.stripeCheckoutSessionsCreate.mockResolvedValue({
    id: 'cs_concierge_1',
    url: 'https://checkout.stripe.com/cs_concierge_1',
  });
  mocks.createSumUpApplicationConciergeCheckout.mockResolvedValue({ id: 'sumup_concierge_1' });
});

describe('application concierge checkout', () => {
  it('creates a 39.99 EUR, non-renewing parent service', async () => {
    const result = await handleCreateApplicationConciergeCheckout(request());

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        url: 'https://checkout.stripe.com/cs_concierge_1',
        serviceId: 'application_concierge_services-1',
      },
    });
    expect(mocks.stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      line_items: [{
        price_data: expect.objectContaining({ currency: 'eur', unit_amount: 3999 }),
        quantity: 1,
      }],
      metadata: expect.objectContaining({
        product: 'application_concierge',
        serviceId: 'application_concierge_services-1',
        userId: 'candidate-42',
      }),
      payment_intent_data: {
        metadata: expect.objectContaining({ product: 'application_concierge' }),
      },
    }), expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^application-concierge:/),
    }));
    expect(mocks.store.get('application_concierge_services/application_concierge_services-1')).toEqual(expect.objectContaining({
      plan: '30d-10-positions',
      renewal: false,
      maxPositions: 10,
      acceptedPositionsCount: 0,
      paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment',
    }));
  });

  it('renews a legacy Stripe checkout that expired while the ledger still says open', async () => {
    const serviceId = 'legacy-service';
    mocks.store.set(`application_concierge_services/${serviceId}`, {
      userId: 'candidate-42', paymentProvider: 'stripe', paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open',
      stripeCheckoutSessionId: 'cs_expired', customerEmail: 'candidate@example.test', checkoutAttempt: 1,
    });
    mocks.getAssistedApplicationPaymentProvider.mockResolvedValue('sumup');
    mocks.stripeCheckoutSessionsRetrieve.mockResolvedValue({ id: 'cs_expired', status: 'expired', payment_status: 'unpaid' });
    const base = request();
    const result = await handleCreateApplicationConciergeCheckout(request({ body: { ...base.body, serviceId } }));
    expect(result).toMatchObject({ status: 200, body: {
      ok: true, serviceId, url: 'https://checkout.stripe.com/cs_concierge_1',
    } });
    expect(mocks.stripeCheckoutSessionsRetrieve).toHaveBeenCalledWith('cs_expired');
    expect(mocks.stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [expect.objectContaining({ price_data: expect.objectContaining({ unit_amount: 3999 }) })],
    }), expect.anything());
    expect(mocks.createSumUpApplicationConciergeCheckout).not.toHaveBeenCalled();
    expect(mocks.store.get(`application_concierge_services/${serviceId}`)).toMatchObject({
      paymentProvider: 'stripe', checkoutAttempt: 2, checkoutSessionStatus: 'open', stripeCheckoutSessionId: 'cs_concierge_1',
    });
  });

  it.each(['EXPIRED', 'FAILED', 'CANCELLED'])('renews stale-open SumUp provider state %s', async (status) => {
    const serviceId = 'legacy-sumup';
    mocks.store.set(`application_concierge_services/${serviceId}`, {
      userId: 'candidate-42', paymentProvider: 'sumup', paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open',
      sumupCheckoutId: 'sumup-old', customerEmail: 'candidate@example.test', checkoutAttempt: 1,
    });
    mocks.retrieveSumUpCheckout.mockResolvedValue({ id: 'sumup-old', checkout_reference: serviceId, status, amount: 39.99, currency: 'EUR' });
    const base = request();
    const result = await handleCreateApplicationConciergeCheckout(request({ body: { ...base.body, serviceId } }));
    expect(result).toMatchObject({ status: 200, body: {
      ok: true, serviceId, paymentProvider: 'sumup', checkoutId: 'sumup_concierge_1',
    } });
    expect(mocks.createSumUpApplicationConciergeCheckout).toHaveBeenCalledWith({
      serviceId, redirectUrl: expect.stringContaining(serviceId),
    });
    expect(mocks.store.get(`application_concierge_services/${serviceId}`)).toMatchObject({ checkoutAttempt: 2, sumupCheckoutId: 'sumup_concierge_1' });
  });

  it('does not reopen a terminal SumUp checkout returned by duplicate-reference recovery', async () => {
    const serviceId = 'stale-sumup';
    mocks.store.set(`application_concierge_services/${serviceId}`, {
      userId: 'candidate-42', paymentProvider: 'sumup', paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open',
      sumupCheckoutId: 'sumup-old', customerEmail: 'candidate@example.test',
    });
    mocks.retrieveSumUpCheckout.mockResolvedValue({ id: 'sumup-old', checkout_reference: serviceId, status: 'FAILED', amount: 39.99, currency: 'EUR' });
    mocks.createSumUpApplicationConciergeCheckout.mockResolvedValueOnce({ id: 'sumup-old' });
    const base = request();
    const result = await handleCreateApplicationConciergeCheckout(request({ body: { ...base.body, serviceId } }));
    expect(result).toMatchObject({ status: 502, body: { ok: false, error: 'application_concierge_checkout_unavailable' } });
    expect(result.body.checkoutId).toBeUndefined();
  });

  it('reconciles an already paid SumUp checkout before returning to the service', async () => {
    const serviceId = 'paid-sumup';
    mocks.store.set(`application_concierge_services/${serviceId}`, {
      userId: 'candidate-42', paymentProvider: 'sumup', paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open',
      sumupCheckoutId: 'sumup-paid', customerEmail: 'candidate@example.test',
    });
    mocks.retrieveSumUpCheckout.mockResolvedValue({ id: 'sumup-paid', checkout_reference: serviceId, status: 'PAID', amount: 39.99, currency: 'EUR' });
    const base = request();
    const result = await handleCreateApplicationConciergeCheckout(request({ body: { ...base.body, serviceId } }));
    expect(result).toMatchObject({ status: 200, body: { ok: true, serviceId, url: expect.stringContaining(serviceId) } });
    expect(mocks.applySumUpCheckout).toHaveBeenCalledWith(expect.objectContaining({ id: 'sumup-paid' }), expect.anything());
    expect(mocks.createSumUpApplicationConciergeCheckout).not.toHaveBeenCalled();
  });

  it.each([
    { checkout_reference: 'another-service' }, { amount: 1.99 }, { currency: 'CHF' }, { status: 'UNKNOWN' },
  ])('does not expose or renew an unverified SumUp checkout: %j', async (override) => {
    const serviceId = 'invalid-sumup';
    mocks.store.set(`application_concierge_services/${serviceId}`, {
      userId: 'candidate-42', paymentProvider: 'sumup', paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open',
      sumupCheckoutId: 'sumup-old', customerEmail: 'candidate@example.test',
    });
    mocks.retrieveSumUpCheckout.mockResolvedValue({ id: 'sumup-old', checkout_reference: serviceId, status: 'PENDING', amount: 39.99, currency: 'EUR', ...override });
    const base = request();
    const result = await handleCreateApplicationConciergeCheckout(request({ body: { ...base.body, serviceId } }));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.checkoutId).toBeUndefined();
    expect(mocks.createSumUpApplicationConciergeCheckout).not.toHaveBeenCalled();
  });

  it('creates an embedded SumUp checkout for the concierge price', async () => {
    mocks.getAssistedApplicationPaymentProvider.mockResolvedValue('sumup');

    const result = await handleCreateApplicationConciergeCheckout(request());

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        paymentProvider: 'sumup',
        checkoutId: 'sumup_concierge_1',
        serviceId: 'application_concierge_services-1',
      },
    });
    expect(mocks.createSumUpApplicationConciergeCheckout).toHaveBeenCalledWith({
      serviceId: 'application_concierge_services-1',
      redirectUrl: 'https://frontaliereticino.ch/lavoro?application_concierge_service_id=application_concierge_services-1',
    });
    expect(mocks.createSumUpHostedCheckout).not.toHaveBeenCalled();
    expect(mocks.store.get('application_concierge_services/application_concierge_services-1')).toEqual(expect.objectContaining({
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_concierge_1',
      amountTotal: 3999,
      paymentStatus: 'pending',
    }));
  });

  it('reuses the same embedded SumUp checkout for an idempotent retry', async () => {
    mocks.getAssistedApplicationPaymentProvider.mockResolvedValue('sumup');

    const first = await handleCreateApplicationConciergeCheckout(request());
    const second = await handleCreateApplicationConciergeCheckout(request());

    expect(second).toEqual(first);
    expect(mocks.createSumUpApplicationConciergeCheckout).toHaveBeenCalledTimes(1);
  });

  it('rejects redirect URLs that are not HTTPS', async () => {
    await expect(handleCreateApplicationConciergeCheckout(request({
      body: {
        ...request().body,
        successUrl: 'http://evil.example.test/callback',
      },
    }))).resolves.toEqual({
      status: 400,
      body: { ok: false, error: 'invalid_redirect_urls' },
    });
    expect(mocks.stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('activates the parent for exactly 30 days only after a matching paid webhook', async () => {
    mocks.store.set('application_concierge_services/service-42', {
      userId: 'candidate-42',
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: 'cs_concierge_42',
      paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment',
      renewal: false,
    });

    const paidAt = 1_700_000_000_000;
    await expect(handleApplicationConciergeWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_concierge_42',
          amount_total: 3999,
          currency: 'eur',
          payment_status: 'paid',
          client_reference_id: 'service-42',
          metadata: { product: 'application_concierge', serviceId: 'service-42' },
        },
      },
    }, { db: mocks.db, ts: '__webhook_timestamp__', nowMs: () => paidAt })).resolves.toBe(true);

    expect(mocks.store.get('application_concierge_services/service-42')).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
      serviceStatus: 'active',
      renewal: false,
      paidAt: expect.objectContaining({ toMillis: expect.any(Function) }),
      expiresAt: expect.objectContaining({ toMillis: expect.any(Function) }),
    }));
    const service = mocks.store.get('application_concierge_services/service-42')!;
    expect((service.expiresAt as any).toMillis()).toBe(paidAt + 30 * 24 * 60 * 60 * 1000);
  });

  it('fails closed on an amount mismatch instead of granting the service', async () => {
    mocks.store.set('application_concierge_services/service-43', {
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: 'cs_concierge_43',
      paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment',
    });

    await handleApplicationConciergeWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_concierge_43',
          amount_total: 99,
          currency: 'eur',
          payment_status: 'paid',
          client_reference_id: 'service-43',
          metadata: { product: 'application_concierge', serviceId: 'service-43' },
        },
      },
    }, { db: mocks.db, ts: '__webhook_timestamp__', nowMs: () => 1_700_000_000_000 });

    expect(mocks.store.get('application_concierge_services/service-43')).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      serviceStatus: 'payment_failed',
    }));
  });

  it('upgrades a failed SumUp attempt when a later retry is paid', async () => {
    mocks.store.set('application_concierge_services/service-44', {
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_concierge_retry',
      paymentStatus: 'failed',
      serviceStatus: 'payment_failed',
      paymentFailureReason: 'payment_not_confirmed',
    });

    await expect(handleApplicationConciergeWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sumup_concierge_retry',
          amount_total: 3999,
          currency: 'eur',
          payment_status: 'paid',
          client_reference_id: 'service-44',
          metadata: { product: 'application_concierge', paymentProvider: 'sumup', serviceId: 'service-44' },
        },
      },
    }, { db: mocks.db, ts: '__webhook_timestamp__', nowMs: () => 1_700_000_000_000 })).resolves.toBe(true);

    expect(mocks.store.get('application_concierge_services/service-44')).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
      serviceStatus: 'active',
      paymentFailureReason: null,
    }));
  });
});


describe('concierge SumUp callback during replacement', () => {
  it.each(['unpaid', 'paid'])('rereads the lease and preserves a concurrent replacement for %s callbacks', async (payment_status) => {
    const key = 'application_concierge_services/service-replacement';
    mocks.store.set(key, { userId: 'candidate-42', paymentProvider: 'sumup', sumupCheckoutId: 'old',
      paymentStatus: 'pending', serviceStatus: 'awaiting_payment', checkoutSessionStatus: 'open' });
    const racingDb = { ...mocks.firestore,
      async runTransaction(callback: (transaction: any) => Promise<unknown>) {
        // The callback originally saw open; the transaction must observe the
        // lease another request acquired before applying this payment event.
        mocks.store.set(key, { ...mocks.store.get(key), checkoutSessionStatus: 'creating' });
        return mocks.firestore.runTransaction(callback);
      },
    };
    await handleApplicationConciergeWebhookEvent({
      type: payment_status === 'paid' ? 'checkout.session.completed' : 'checkout.session.async_payment_failed',
      data: { object: { id: 'old', amount_total: 3999, currency: 'eur', payment_status,
        metadata: { product: 'application_concierge', paymentProvider: 'sumup', serviceId: 'service-replacement' },
      } },
    }, { db: () => racingDb, ts: '__webhook_timestamp__', nowMs: Date.now });
    expect(mocks.store.get(key)).toMatchObject(payment_status === 'paid'
      ? { checkoutSessionStatus: 'completed', paymentStatus: 'paid', serviceStatus: 'active' }
      : { checkoutSessionStatus: 'creating', paymentStatus: 'pending', serviceStatus: 'awaiting_payment' });
  });
});
