import { describe, expect, it, beforeEach, vi } from 'vitest';

let store: Record<string, Record<string, Record<string, unknown>>> = {};
let generatedOrderNumber = 0;

function makeDocRef(collectionName: string, id: string) {
  return {
    id,
    async get() {
      const data = store[collectionName]?.[id];
      return { id, exists: data != null, data: () => data };
    },
    async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
      const current = store[collectionName]?.[id] || {};
      store[collectionName] ||= {};
      store[collectionName][id] = options?.merge ? { ...current, ...data } : data;
    },
  };
}

function makeFirestore() {
  const database = () => ({
    collection: (name: string) => ({
      doc: (id?: string) => makeDocRef(name, id || `order-${++generatedOrderNumber}`),
    }),
    runTransaction: async (callback: any) => callback({
      get: (ref: any) => ref.get(),
      set: (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => ref.set(data, options),
    }),
  });
  return Object.assign(
    database,
    { FieldValue: { serverTimestamp: () => '__server_timestamp__' } },
  );
}

const firestore = makeFirestore();
const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'good-token') return { uid: 'user-42', email: 'candidate@example.com' };
  throw new Error('invalid_token');
});

vi.mock('firebase-admin', () => ({
  default: {
    firestore,
    auth: () => ({ verifyIdToken }),
  },
}));

const getRemoteConfigValueMock = vi.fn(async (key: string) => {
  if (key === 'STRIPE_SECRET_KEY') return 'sk_test_assisted';
  if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_assisted';
  return '';
});

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => getRemoteConfigValueMock(key),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const stripeCheckoutSessionsCreate = vi.fn(async () => ({
  id: 'cs_assisted_1',
  url: 'https://checkout.stripe.com/cs_assisted_1',
}));
const stripeConstructEvent = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    checkout = { sessions: { create: stripeCheckoutSessionsCreate } };
    webhooks = { constructEvent: stripeConstructEvent };
  }
  return { default: MockStripe };
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: {
      jobId: 'job-42',
      companyId: 'company-acme',
      jobUrl: 'https://jobs.example.test/jobs/job-42',
      companyName: 'ACME SA',
      jobTitle: 'Software Developer',
      experimentVariant: 'assisted_application',
      successUrl: 'https://frontaliereticino.ch/lavoro/job-42',
      cancelUrl: 'https://frontaliereticino.ch/lavoro/job-42',
      requestKey: 'assisted-request-key-42',
      amount: 1,
    },
    get: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer good-token' : ''),
    ...overrides,
  };
}

async function loadCheckout() {
  return import('../functions/src/assistedApplicationCheckout.js');
}

beforeEach(() => {
  store = {};
  generatedOrderNumber = 0;
  vi.clearAllMocks();
  getRemoteConfigValueMock.mockImplementation(async (key: string) => {
    if (key === 'STRIPE_SECRET_KEY') return 'sk_test_assisted';
    if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_assisted';
    return '';
  });
  stripeCheckoutSessionsCreate.mockImplementation(async () => ({
    id: 'cs_assisted_1',
    url: 'https://checkout.stripe.com/cs_assisted_1',
  }));
});

describe('handleCreateAssistedApplicationCheckout', () => {
  it('requires an authenticated POST', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    expect(await handleCreateAssistedApplicationCheckout(request({ method: 'GET' }))).toEqual({
      status: 405,
      body: { ok: false, error: 'method_not_allowed' },
    });
    expect(await handleCreateAssistedApplicationCheckout(request({
      get: () => 'Bearer bad-token',
    }))).toEqual({
      status: 401,
      body: { ok: false, error: 'unauthenticated' },
    });
  });

  it('creates a pending owner-bound order and fixes the Checkout amount at 99 EUR cents', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const result = await handleCreateAssistedApplicationCheckout(request());

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        url: 'https://checkout.stripe.com/cs_assisted_1',
        orderId: 'order-1',
      },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      line_items: [{
        price_data: expect.objectContaining({ currency: 'eur', unit_amount: 99 }),
        quantity: 1,
      }],
      metadata: expect.objectContaining({
        product: 'assisted_application',
        jobId: 'job-42',
        jobUrl: 'https://jobs.example.test/jobs/job-42',
        companyName: 'ACME SA',
      }),
      payment_intent_data: {
        metadata: expect.objectContaining({ product: 'assisted_application', orderId: 'order-1' }),
      },
    }), expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^assisted-application:/),
    }));
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      orderId: 'order-1',
      userId: 'user-42',
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      stripeCheckoutSessionId: 'cs_assisted_1',
      consentVersion: null,
      consentedAt: null,
    }));
  });

  it('reuses the persisted request key, order and Stripe session on a retry', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second).toEqual(first);
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.assisted_application_checkout_requests)).toHaveLength(1);
  });

  it('rejects a reused request key when the checkout payload changes', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    await handleCreateAssistedApplicationCheckout(request());
    const result = await handleCreateAssistedApplicationCheckout(request({
      body: { ...request().body, jobId: 'job-other' },
    }));

    expect(result).toEqual({
      status: 409,
      body: { ok: false, error: 'assisted_application_request_conflict' },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects non-HTTPS job and redirect URLs before contacting Stripe', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const result = await handleCreateAssistedApplicationCheckout(request({
      body: { ...request().body, jobUrl: 'http://jobs.example.test/job-42' },
    }));

    expect(result).toEqual({ status: 400, body: { ok: false, error: 'invalid_job' } });
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

describe('handleAssistedApplicationWebhookEvent', () => {
  it('marks an order paid only on the signed-webhook dispatch target', async () => {
    const { handleCreateAssistedApplicationCheckout, handleAssistedApplicationWebhookEvent } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());

    const handled = await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 99,
          currency: 'eur',
          payment_status: 'paid',
          customer_details: { email: 'candidate@example.com' },
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    expect(handled).toBe(true);
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      paidAt: '__webhook_timestamp__',
      stripeSessionId: 'cs_assisted_1',
    }));
  });

  it('does not promote a completed session whose Stripe payment is not paid', async () => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();

    const handled = await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_unpaid',
          amount_total: 99,
          currency: 'eur',
          payment_status: 'unpaid',
          metadata: { product: 'assisted_application', orderId: 'order-unpaid' },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    expect(handled).toBe(true);
    expect(store.assisted_applications['order-unpaid']).toEqual(expect.objectContaining({
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
    }));
  });

  it('fails closed when a signed completion omits the fixed amount or currency', async () => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_missing_money',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-missing-money' },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    expect(store.assisted_applications['order-missing-money']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      submissionStatus: 'awaiting_payment',
      paymentFailureReason: 'amount_or_currency_missing_or_mismatch',
    }));
  });

  it('supports a later async-payment success event without exposing a second endpoint', async () => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: 'cs_async',
          amount_total: 99,
          currency: 'eur',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-async' },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    expect(store.assisted_applications['order-async'].paymentStatus).toBe('paid');
  });

  it('marks an expired Checkout session as failed without opening the upload gate', async () => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_expired',
          metadata: { product: 'assisted_application', orderId: 'order-expired' },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    expect(store.assisted_applications['order-expired']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      submissionStatus: 'awaiting_payment',
    }));
  });
});

describe('signed project-wide Stripe webhook wiring', () => {
  it('verifies the Stripe signature before dispatching assisted payments', async () => {
    const event = {
      id: 'evt_assisted_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 99,
          currency: 'eur',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    };
    stripeConstructEvent.mockReturnValue(event);

    const { handleStripeWebhook } = await import('../functions/src/stripePublisherCore.js');
    const result = await handleStripeWebhook({
      rawBody: Buffer.from('stripe-payload'),
      get: (name: string) => (name === 'stripe-signature' ? 'sig_assisted' : ''),
    });

    expect(stripeConstructEvent).toHaveBeenCalledWith(
      expect.anything(),
      'sig_assisted',
      'whsec_assisted',
    );
    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(store.stripe_events.evt_assisted_1).toEqual(expect.objectContaining({
      type: 'checkout.session.completed',
    }));
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
    }));
  });
});
