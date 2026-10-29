import { describe, expect, it, beforeEach, vi } from 'vitest';

let store: Record<string, Record<string, Record<string, unknown>>> = {};
let generatedOrderNumber = 0;

function makeCollectionRef(collectionName: string) {
  return {
    doc: (id?: string) => makeDocRef(collectionName, id || `order-${++generatedOrderNumber}`),
    async get() {
      return {
        docs: Object.entries(store[collectionName] || {}).map(([id, data]) => ({
          id,
          data: () => data,
          ref: makeDocRef(collectionName, id),
        })),
      };
    },
    where(field: string, _operator: string, value: unknown) {
      return {
        async get() {
          return {
            docs: Object.entries(store[collectionName] || {})
              .filter(([, data]) => data[field] === value)
              .map(([id, data]) => ({ id, data: () => data, ref: makeDocRef(collectionName, id) })),
          };
        },
      };
    },
  };
}

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
    collection: (name: string) => makeCollectionRef(`${collectionName}/${id}/${name}`),
  };
}

function makeFirestore() {
  const database = () => ({
    collection: (name: string) => makeCollectionRef(name),
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

const { generateServerTextMock } = vi.hoisted(() => ({ generateServerTextMock: vi.fn() }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: generateServerTextMock }));

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

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => firestore(),
  FieldValue: firestore.FieldValue,
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
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
  expires_at: 4102444800,
}));
const stripeCheckoutSessionsRetrieve = vi.fn(async () => ({
  id: 'cs_assisted_1',
  status: 'open',
  expires_at: 4102444800,
}));
const stripeConstructEvent = vi.fn();
const assistedApplicationPaymentProvider = vi.fn(async () => 'stripe');
const sumUpCheckoutCreate = vi.fn(async () => ({
  id: 'sumup_checkout_1',
}));
const retrieveSumUpCheckoutMock = vi.fn();
const applySumUpCheckoutMock = vi.fn();

vi.mock('stripe', () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: stripeCheckoutSessionsCreate,
        retrieve: stripeCheckoutSessionsRetrieve,
      },
    };
    webhooks = { constructEvent: stripeConstructEvent };
  }
  return { default: MockStripe };
});

vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  getAssistedApplicationPaymentProvider: (...args: unknown[]) => assistedApplicationPaymentProvider(...args),
  createSumUpAssistedApplicationCheckout: (...args: unknown[]) => sumUpCheckoutCreate(...args),
  SUMUP_PAYMENT_PROVIDER: 'sumup',
  retrieveSumUpCheckout: (...args: unknown[]) => retrieveSumUpCheckoutMock(...args),
}));
vi.mock('../functions/src/assistedApplicationSumupWebhook.js', () => ({
  applyAssistedApplicationSumUpCheckout: (...args: unknown[]) => applySumUpCheckoutMock(...args),
}));

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: {
      jobId: 'job-42',
      companyId: 'company-acme',
      jobUrl: 'https://jobs.example.test/jobs/job-42',
      companyName: 'ACME SA',
      jobTitle: 'Software Developer',
      companyLogo: 'https://cdn.example.test/logos/acme.png',
      companyKey: 'company-acme',
      location: 'Lugano',
      canton: 'TI',
      contract: 'full-time',
      salaryMin: 75000,
      salaryMax: 90000,
      salarySource: 'reported',
      salaryCurrency: 'CHF',
      baseSalary: { currency: 'CHF', value: { minValue: 75000, maxValue: 90000, unitText: 'YEAR' } },
      postedDate: '2026-10-01',
      firstSeenAt: '2026-10-02T10:00:00.000Z',
      sector: 'Tecnologia',
      category: 'tech',
      experimentVariant: 'assisted_application',
      copyVariant: 'time_saved',
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
  generateServerTextMock.mockReset();
  getRemoteConfigValueMock.mockImplementation(async (key: string) => {
    if (key === 'STRIPE_SECRET_KEY') return 'sk_test_assisted';
    if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_assisted';
    return '';
  });
  stripeCheckoutSessionsCreate.mockImplementation(async () => ({
    id: 'cs_assisted_1',
    url: 'https://checkout.stripe.com/cs_assisted_1',
    expires_at: 4102444800,
  }));
  stripeCheckoutSessionsRetrieve.mockImplementation(async (id?: string) => ({
    id: id || 'cs_assisted_1', status: 'open', payment_status: 'unpaid', amount_total: 199, currency: 'eur',
    url: 'https://checkout.stripe.com/' + (id || 'cs_assisted_1'), expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  assistedApplicationPaymentProvider.mockResolvedValue('stripe');
  sumUpCheckoutCreate.mockImplementation(async () => ({
    id: 'sumup_checkout_1',
  }));
  retrieveSumUpCheckoutMock.mockImplementation(async (id: string) => {
    const entry = Object.entries(store.assisted_applications || {}).find(([, row]) => row.sumupCheckoutId === id);
    return { id, checkout_reference: entry?.[0], amount: 1.99, currency: 'EUR', status: 'PENDING' };
  });
  applySumUpCheckoutMock.mockImplementation(async (checkout: { id: string; checkout_reference: string }) => {
    const row = store.assisted_applications[checkout.checkout_reference];
    if (row?.sumupCheckoutId === checkout.id && row.paymentStatus !== 'refunded') {
      Object.assign(row, { paymentStatus: 'paid', checkoutSessionStatus: 'completed' });
    }
    return { paymentStatus: row?.paymentStatus };
  });
});

describe('handleCreateAssistedApplicationCheckout', () => {
  it('blocks a certain CV mismatch before creating a payment checkout', async () => {
    store.user_cv_profiles = {
      'user-42': {
        status: 'ready',
        profile: { languages: ['English'], languagesExplicitList: true },
      },
    };
    generateServerTextMock.mockImplementation(async ({ systemPrompt }: { systemPrompt: string }) => ({
      status: 200,
      body: {
        ok: true,
        text: JSON.stringify(systemPrompt.startsWith('You analyse a Swiss job posting')
          ? { requirements: [{ requirement: 'Tedesco fluente', importance: 'critical', basis: 'stated', quote: 'Fluent German required' }] }
          : { matches: [{ index: 0, status: 'missing', evidence: 'English' }], verdict: 'poor', questions: [] }),
      },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      async json() { return { description: `Fluent German required. ${'IT operations and infrastructure. '.repeat(20)} on the posting.` }; },
    })));
    try {
      const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
      await expect(handleCreateAssistedApplicationCheckout(request())).resolves.toEqual({
        status: 409,
        body: {
          ok: false,
          error: 'assisted_application_incompatible',
          gaps: [expect.objectContaining({ requirement: 'Tedesco fluente', status: 'missing' })],
        },
      });
      expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(store.assisted_applications).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes an already accepted concierge position without opening a second checkout', async () => {
    store.application_concierge_services = {
      'service-42': { userId: 'user-42' },
    };
    store['application_concierge_services/service-42/proposals'] = {
      'proposal-42': {
        status: 'accepted',
        jobId: 'job-42',
        jobUrl: 'https://jobs.example.test/jobs/job-42',
        childApplicationId: 'child-42',
      },
    };
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    await expect(handleCreateAssistedApplicationCheckout(request())).resolves.toEqual({
      status: 409,
      body: {
        ok: false,
        error: 'application_concierge_proposal_already_accepted',
        serviceId: 'service-42',
        proposalId: 'proposal-42',
        childApplicationId: 'child-42',
      },
    });
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it.each(['stripe', 'sumup'])('uses the real client redirect contract when %s payment wins during creation', async (provider) => {
    assistedApplicationPaymentProvider.mockResolvedValue(provider);
    const complete = async () => {
      const order = store.assisted_applications['order-1'];
      Object.assign(order, { paymentStatus: 'paid', checkoutSessionStatus: 'completed',
        ...(provider === 'sumup' ? { sumupCheckoutId: 'sumup_checkout_1' } : { stripeCheckoutSessionId: 'cs_assisted_1' }) });
      return provider === 'sumup' ? { id: 'sumup_checkout_1' } : {
        id: 'cs_assisted_1', url: 'https://checkout.stripe.com/cs_assisted_1', expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    };
    if (provider === 'sumup') sumUpCheckoutCreate.mockImplementation(complete as any);
    else stripeCheckoutSessionsCreate.mockImplementation(complete as any);
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const response = await handleCreateAssistedApplicationCheckout(request());
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('checkoutId');
    expect(response.body).not.toHaveProperty('paymentProvider');
    expect(store.assisted_applications['order-1']).toMatchObject({ paymentStatus: 'paid', checkoutSessionStatus: 'completed' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: response.status,
      json: async () => response.body } as Response);
    try {
      const { createAssistedApplicationCheckout } = await import('../services/assistedApplicationCheckout');
      const result = await createAssistedApplicationCheckout(request().body as any, {
        uid: 'user-42', getIdToken: async () => 'good-token',
      });
      expect(result).toMatchObject({ ok: true, orderId: 'order-1', url: expect.stringContaining('assisted_application_order_id=order-1') });
      expect(result.paymentProvider).not.toBe('sumup');
      expect(new URL((result as { url: string }).url).origin).toBe('https://frontaliereticino.ch');
    } finally { fetchSpy.mockRestore(); }
  });

  it.each(['stripe', 'sumup'])('does not publish a payable %s checkout after a concurrent refund', async (provider) => {
    assistedApplicationPaymentProvider.mockResolvedValue(provider);
    const refund = async () => {
      Object.assign(store.assisted_applications['order-1'], { paymentStatus: 'refunded', checkoutSessionStatus: 'refunded' });
      return provider === 'sumup' ? { id: 'sumup_checkout_1' } : {
        id: 'cs_assisted_1', url: 'https://checkout.stripe.com/cs_assisted_1', expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    };
    if (provider === 'sumup') sumUpCheckoutCreate.mockImplementation(refund as any);
    else stripeCheckoutSessionsCreate.mockImplementation(refund as any);
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const response = await handleCreateAssistedApplicationCheckout(request());
    expect(response).toEqual({ status: 409, body: { ok: false, error: 'assisted_application_payment_refunded' } });
    expect(store.assisted_applications['order-1']).toMatchObject({ paymentStatus: 'refunded', checkoutSessionStatus: 'refunded' });
    expect(Object.values(store.assisted_application_checkout_requests)[0].checkoutSessionStatus).toBe('creating');
  });

  it.each(['owner', 'request', 'attempt', 'checkout', 'provider-key'])('refuses an obsolete publication after %s identity changes', async (changed) => {
    stripeCheckoutSessionsCreate.mockImplementation(async () => {
      const order = store.assisted_applications['order-1'];
      const record = Object.values(store.assisted_application_checkout_requests)[0];
      if (changed === 'owner') order.userId = 'another-owner';
      if (changed === 'request') record.orderId = 'new-order';
      if (changed === 'attempt') { order.checkoutAttempt = 2; record.checkoutAttempt = 2; }
      if (changed === 'checkout') order.stripeCheckoutSessionId = 'another-checkout';
      if (changed === 'provider-key') record.stripeRequestKey = 'another-provider-key';
      return { id: 'cs_assisted_1', url: 'https://checkout.stripe.com/cs_assisted_1', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    });
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    expect(await handleCreateAssistedApplicationCheckout(request())).toEqual({ status: 409,
      body: { ok: false, error: 'assisted_application_request_conflict' } });
    expect(Object.values(store.assisted_application_checkout_requests)[0].checkoutSessionStatus).toBe('creating');
  });

  it.each(['PENDING', 'FAILED'])('reuses a known SumUp failure when server truth is %s without a second payable', async (status) => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    Object.assign(store.assisted_applications[first.body.orderId], { paymentStatus: 'failed',
      paymentFailureReason: 'payment_not_confirmed', checkoutSessionStatus: 'failed' });
    retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'sumup_checkout_1', checkout_reference: first.body.orderId,
      amount: 1.99, currency: 'EUR', status });
    const retry = await handleCreateAssistedApplicationCheckout(request());
    expect(retry).toEqual(first);
    expect(sumUpCheckoutCreate).toHaveBeenCalledOnce();
    expect(Object.keys(store.assisted_applications)).toHaveLength(1);
    expect(store.assisted_applications[first.body.orderId]).toMatchObject({ paymentStatus: 'pending', checkoutSessionStatus: 'open', paymentFailureReason: null });
  });

  it('returns a client-compatible paid redirect after verifying a cached SumUp checkout', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'sumup_checkout_1', checkout_reference: first.body.orderId,
      amount: 1.99, currency: 'EUR', status: 'PAID' });
    const response = await handleCreateAssistedApplicationCheckout(request());
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('checkoutId');
    expect(sumUpCheckoutCreate).toHaveBeenCalledOnce();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: response.status, json: async () => response.body } as Response);
    try {
      const { createAssistedApplicationCheckout } = await import('../services/assistedApplicationCheckout');
      expect(await createAssistedApplicationCheckout(request().body as any, { uid: 'user-42', getIdToken: async () => 'good-token' }))
        .toMatchObject({ url: expect.stringContaining('assisted_application_order_id=order-1'), orderId: first.body.orderId });
    } finally { fetchSpy.mockRestore(); }
  });

  it('rotates a cached SumUp checkout only when the provider confirms EXPIRED', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'sumup_checkout_1', checkout_reference: first.body.orderId,
      amount: 1.99, currency: 'EUR', status: 'EXPIRED' });
    sumUpCheckoutCreate.mockResolvedValueOnce({ id: 'sumup_checkout_2' });
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ status: 200, body: {
      orderId: 'order-2', checkoutId: 'sumup_checkout_2', paymentProvider: 'sumup',
    } });
    expect(sumUpCheckoutCreate).toHaveBeenCalledTimes(2);
  });

  it.each(['CANCELLED', 'UNKNOWN'])('does not create another payable for unknown cached provider state %s', async (status) => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'sumup_checkout_1', checkout_reference: first.body.orderId,
      amount: 1.99, currency: 'EUR', status });
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ status: 409, body: { ok: false } });
    expect(sumUpCheckoutCreate).toHaveBeenCalledOnce();
    expect(Object.keys(store.assisted_applications)).toHaveLength(1);
  });

  it('refreshes the landing-page cache after recovery replaced the SumUp provider ID', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    Object.assign(store.assisted_applications[first.body.orderId], { sumupCheckoutId: 'renewed', checkoutAttempt: 2 });
    retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'renewed', checkout_reference: first.body.orderId + '~sumup~2', amount: 1.99, currency: 'EUR', status: 'PENDING' });
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ body: { orderId: first.body.orderId, checkoutId: 'renewed' } });
    expect(Object.values(store.assisted_application_checkout_requests)[0]).toMatchObject({ sumupCheckoutId: 'renewed', checkoutAttempt: 2 });
    expect(sumUpCheckoutCreate).toHaveBeenCalledOnce();
  });

  it('honours authoritative Stripe OPEN even when the cached expiry is stale and the legacy key is absent', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    const order = store.assisted_applications[first.body.orderId];
    const record = Object.values(store.assisted_application_checkout_requests)[0];
    order.checkoutExpiresAt = Math.floor(Date.now() / 1000) - 60;
    record.checkoutExpiresAt = order.checkoutExpiresAt;
    delete order.stripeRequestKey;
    delete record.stripeRequestKey;
    delete order.checkoutAttempt;
    record.checkoutAttempt = 2;
    expect(await handleCreateAssistedApplicationCheckout(request())).toEqual(first);
    expect(stripeCheckoutSessionsRetrieve).toHaveBeenCalledWith('cs_assisted_1');
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledOnce();
    const fresh = Object.values(store.assisted_application_checkout_requests)[0];
    expect(typeof fresh.stripeRequestKey).toBe('string');
    expect(fresh.checkoutAttempt).toBe(2);
    expect(fresh.stripeRequestKey).toMatch(/:2$/);
    expect(Object.values(fresh)).not.toContain(undefined);
    expect(Number(store.assisted_applications[first.body.orderId].checkoutExpiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('refreshes a Stripe cached URL from the current provider ID after recovery', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    Object.assign(store.assisted_applications[first.body.orderId], { stripeCheckoutSessionId: 'cs_recovered', checkoutAttempt: 2,
      stripeRequestKey: 'recovered-key' });
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ body: {
      orderId: first.body.orderId, url: 'https://checkout.stripe.com/cs_recovered',
    } });
    expect(Object.values(store.assisted_application_checkout_requests)[0]).toMatchObject({ stripeCheckoutSessionId: 'cs_recovered',
      checkoutUrl: 'https://checkout.stripe.com/cs_recovered', checkoutAttempt: 2, stripeRequestKey: 'recovered-key' });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledOnce();
  });

  it('reconciles a cached Stripe payment and returns the actual client paid redirect', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    stripeCheckoutSessionsRetrieve.mockImplementationOnce(async () => ({ id: 'cs_assisted_1', status: 'complete', payment_status: 'paid',
      amount_total: 199, currency: 'eur', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    const response = await handleCreateAssistedApplicationCheckout(request());
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('checkoutId');
    expect(response.body).toMatchObject({ orderId: first.body.orderId, url: expect.stringContaining('assisted_application_order_id=order-1') });
    expect(store.assisted_applications[first.body.orderId].paymentStatus).toBe('paid');
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledOnce();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: response.status, json: async () => response.body } as Response);
    try {
      const { createAssistedApplicationCheckout } = await import('../services/assistedApplicationCheckout');
      expect(await createAssistedApplicationCheckout(request().body as any, { uid: 'user-42', getIdToken: async () => 'good-token' }))
        .toMatchObject({ orderId: first.body.orderId, url: response.body.url });
    } finally { fetchSpy.mockRestore(); }
  });

  it.each(['stripe', 'sumup'])('rejects a %s cache that is no longer bound to the authoritative order ID', async (provider) => {
    assistedApplicationPaymentProvider.mockResolvedValue(provider);
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    store.assisted_applications[first.body.orderId][provider === 'sumup' ? 'sumupCheckoutId' : 'stripeCheckoutSessionId'] = null;
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ status: 409, body: { ok: false } });
    expect(stripeCheckoutSessionsCreate.mock.calls.length + sumUpCheckoutCreate.mock.calls.length).toBe(1);
  });

  it.each(['stripe', 'sumup'])('does not trust a cached %s checkout with the wrong provider amount', async (provider) => {
    assistedApplicationPaymentProvider.mockResolvedValue(provider);
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const first = await handleCreateAssistedApplicationCheckout(request());
    if (provider === 'sumup') retrieveSumUpCheckoutMock.mockResolvedValue({ id: 'sumup_checkout_1', checkout_reference: first.body.orderId,
      amount: 1, currency: 'EUR', status: 'PENDING' });
    else stripeCheckoutSessionsRetrieve.mockImplementationOnce(async () => ({ id: 'cs_assisted_1', status: 'open', payment_status: 'unpaid',
      url: 'https://checkout.stripe.com/cs_assisted_1', amount_total: 100, currency: 'eur', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ status: 502, body: { ok: false } });
    expect(stripeCheckoutSessionsCreate.mock.calls.length + sumUpCheckoutCreate.mock.calls.length).toBe(1);
    expect(Object.keys(store.assisted_applications)).toHaveLength(1);
  });

  it('keeps the existing provider-expiry guard when Stripe still reports OPEN after its own deadline', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());
    stripeCheckoutSessionsRetrieve.mockImplementationOnce(async () => ({ id: 'cs_assisted_1', status: 'open', payment_status: 'unpaid',
      amount_total: 199, currency: 'eur', url: 'https://checkout.stripe.com/cs_assisted_1', expires_at: Math.floor(Date.now() / 1000) - 60 }));
    stripeCheckoutSessionsCreate.mockImplementationOnce(async () => ({ id: 'cs_replacement', url: 'https://checkout.stripe.com/cs_replacement',
      expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    expect(await handleCreateAssistedApplicationCheckout(request())).toMatchObject({ status: 200, body: {
      orderId: 'order-2', url: 'https://checkout.stripe.com/cs_replacement',
    } });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(2);
  });

  it('rejects crawler and automation user-agents before authentication or Stripe', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    const userAgents = ['Googlebot/2.1', 'Mozilla/5.0 HeadlessChrome/140.0.0.0'];

    for (const userAgent of userAgents) {
      const result = await handleCreateAssistedApplicationCheckout(request({
        get: (name: string) => {
          if (name.toLowerCase() === 'user-agent') return userAgent;
          return name.toLowerCase() === 'authorization' ? 'Bearer good-token' : '';
        },
      }));
      expect(result).toEqual({
        status: 403,
        body: { ok: false, error: 'automation_not_allowed' },
      });
    }

    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

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

  it('creates a pending owner-bound order and fixes the Checkout amount at 199 EUR cents', async () => {
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
        price_data: expect.objectContaining({ currency: 'eur', unit_amount: 199 }),
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
      cvFileName: null,
      copyVariant: 'time_saved',
      companyLogo: 'https://cdn.example.test/logos/acme.png',
      companyKey: 'company-acme',
      location: 'Lugano',
      canton: 'TI',
      contract: 'full-time',
      salaryMin: 75000,
      salaryMax: 90000,
      salarySource: 'reported',
      salaryCurrency: 'CHF',
      baseSalary: { currency: 'CHF', value: { minValue: 75000, maxValue: 90000, unitText: 'YEAR' } },
      postedDate: '2026-10-01',
      firstSeenAt: '2026-10-02T10:00:00.000Z',
      sector: 'Tecnologia',
      category: 'tech',
    }));
  });

  it('can create one SumUp widget checkout without changing the one-application order', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const result = await handleCreateAssistedApplicationCheckout(request());

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        paymentProvider: 'sumup',
        checkoutId: 'sumup_checkout_1',
        orderId: 'order-1',
      },
    });
    expect(sumUpCheckoutCreate).toHaveBeenCalledWith({
      orderId: 'order-1',
      redirectUrl: 'https://frontaliereticino.ch/lavoro/job-42?assisted_application_order_id=order-1',
    });
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_checkout_1',
      paymentStatus: 'pending',
      customerEmail: 'candidate@example.com',
    }));
    expect(Object.values(store.assisted_application_checkout_requests)[0]).toEqual(expect.objectContaining({
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_checkout_1',
      checkoutUrl: null,
    }));
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('reuses the persisted SumUp widget checkout on a retry', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second).toEqual(first);
    expect(sumUpCheckoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('rotates an expired Stripe checkout when its expiration webhook was missed', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();
    stripeCheckoutSessionsCreate.mockImplementationOnce(async () => ({
      id: 'cs_assisted_1',
      url: 'https://checkout.stripe.com/cs_assisted_1',
    }));
    await handleCreateAssistedApplicationCheckout(request());

    stripeCheckoutSessionsRetrieve.mockResolvedValueOnce({
      id: 'cs_assisted_1',
      status: 'expired',
      expires_at: 1760000000,
    });
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second).toEqual({
      status: 200,
      body: {
        ok: true,
        paymentProvider: 'sumup',
        checkoutId: 'sumup_checkout_1',
        orderId: 'order-2',
      },
    });
    expect(stripeCheckoutSessionsRetrieve).toHaveBeenCalledWith('cs_assisted_1');
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      checkoutSessionStatus: 'expired',
      paymentFailureReason: 'checkout_session_expired',
    }));
    expect(store.assisted_applications['order-2']).toEqual(expect.objectContaining({
      paymentProvider: 'sumup',
      paymentStatus: 'pending',
      checkoutSessionStatus: 'open',
      checkoutAttempt: 2,
    }));
  });

  it('stores the concierge locale and resume link, and accepts the Offerwall-fallback variant', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    await handleCreateAssistedApplicationCheckout(request({
      body: {
        ...request().body,
        experimentVariant: 'offerwall_fallback',
        successUrl: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/job-42/',
        cancelUrl: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/job-42/',
      },
    }));

    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      locale: 'fr',
      orderPageUrl: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/job-42/?assisted_application_order_id=order-1',
      experimentVariant: 'offerwall_fallback',
    }));
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ locale: 'fr', experimentVariant: 'offerwall_fallback', copyVariant: 'time_saved' }),
    }), expect.anything());
  });

  it('reuses the persisted request key, order and Stripe session on a retry', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second).toEqual(first);
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.assisted_application_checkout_requests)).toHaveLength(1);
  });

  it('returns the upload resume URL when the persisted order is already paid', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    store.assisted_applications[first.body.orderId].paymentStatus = 'paid';
    store.assisted_applications[first.body.orderId].submissionStatus = 'awaiting_upload';
    const resumed = await handleCreateAssistedApplicationCheckout(request());

    expect(resumed).toEqual({
      status: 200,
      body: {
        ok: true,
        url: 'https://frontaliereticino.ch/lavoro/job-42?assisted_application_order_id=order-1',
        orderId: 'order-1',
      },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry idempotent when only localized title and return paths change', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    const resumed = await handleCreateAssistedApplicationCheckout(request({
      body: {
        ...request().body,
        jobTitle: 'Sviluppatore software',
        successUrl: 'https://frontaliereticino.ch/it/lavoro/job-42',
        cancelUrl: 'https://frontaliereticino.ch/it/lavoro/job-42',
      },
    }));

    expect(resumed).toEqual(first);
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.assisted_application_checkout_requests)).toHaveLength(1);
  });

  it('rotates the checkout attempt after Stripe reports the saved session expired', async () => {
    const {
      handleCreateAssistedApplicationCheckout,
      handleAssistedApplicationWebhookEvent,
    } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_assisted_1',
          metadata: { product: 'assisted_application', orderId: first.body.orderId },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    stripeCheckoutSessionsRetrieve.mockResolvedValueOnce({ id: 'cs_assisted_1', status: 'expired', expires_at: Math.floor(Date.now() / 1000) - 60 });
    stripeCheckoutSessionsCreate.mockImplementationOnce(async () => ({
      id: 'cs_assisted_2',
      url: 'https://checkout.stripe.com/cs_assisted_2',
    }));
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second).toEqual({
      status: 200,
      body: {
        ok: true,
        url: 'https://checkout.stripe.com/cs_assisted_2',
        orderId: 'order-2',
      },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(2);
    expect(stripeCheckoutSessionsCreate.mock.calls[1][1].idempotencyKey)
      .not.toBe(stripeCheckoutSessionsCreate.mock.calls[0][1].idempotencyKey);
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      checkoutSessionStatus: 'expired',
    }));
    expect(store.assisted_applications['order-2']).toEqual(expect.objectContaining({
      paymentStatus: 'pending',
      checkoutSessionStatus: 'open',
      checkoutAttempt: 2,
    }));
    expect(Object.values(store.assisted_application_checkout_requests)[0]).toEqual(expect.objectContaining({
      orderId: 'order-2',
      checkoutAttempt: 2,
      checkoutSessionStatus: 'open',
    }));
  });

  it('rotates after a terminal failed Checkout session instead of reusing its URL', async () => {
    const {
      handleCreateAssistedApplicationCheckout,
      handleAssistedApplicationWebhookEvent,
    } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.async_payment_failed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 199,
          currency: 'eur',
          metadata: { product: 'assisted_application', orderId: first.body.orderId },
        },
      },
    }, { db: firestore, ts: '__webhook_timestamp__' });

    stripeCheckoutSessionsRetrieve.mockImplementationOnce(async () => ({ id: 'cs_assisted_1', status: 'complete', payment_status: 'unpaid',
      amount_total: 199, currency: 'eur', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    stripeCheckoutSessionsCreate.mockImplementationOnce(async () => ({
      id: 'cs_assisted_2',
      url: 'https://checkout.stripe.com/cs_assisted_2',
    }));
    const second = await handleCreateAssistedApplicationCheckout(request());

    expect(second.body).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/cs_assisted_2',
      orderId: 'order-2',
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(2);
    expect(stripeCheckoutSessionsCreate.mock.calls[1][1].idempotencyKey)
      .not.toBe(stripeCheckoutSessionsCreate.mock.calls[0][1].idempotencyKey);
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      checkoutSessionStatus: 'failed',
    }));
    expect(store.assisted_applications['order-2']).toEqual(expect.objectContaining({
      paymentStatus: 'pending',
      checkoutSessionStatus: 'open',
      checkoutAttempt: 2,
    }));
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

  it('keeps copy attribution out of checkout identity for existing request keys', async () => {
    const { handleCreateAssistedApplicationCheckout } = await loadCheckout();

    const first = await handleCreateAssistedApplicationCheckout(request());
    const resumed = await handleCreateAssistedApplicationCheckout(request({
      body: { ...request().body, copyVariant: 'portal_relief' },
    }));

    expect(resumed).toEqual(first);
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({ copyVariant: 'time_saved' }));
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
  it.each(['unpaid', 'paid'])('checks a replacement lease inside the payment transaction for %s callbacks', async (payment_status) => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();
    store.assisted_applications = { 'order-1': {
      paymentProvider: 'sumup', sumupCheckoutId: 'current', paymentStatus: 'pending', checkoutSessionStatus: 'creating',
    } };
    await handleAssistedApplicationWebhookEvent({ type: payment_status === 'paid' ? 'checkout.session.completed' : 'checkout.session.expired',
      data: { object: { id: 'current', amount_total: 199, currency: 'eur', payment_status,
        metadata: { product: 'assisted_application', paymentProvider: 'sumup', orderId: 'order-1' },
      } },
    }, { db: firestore, ts: '__webhook_timestamp__' });
    expect(store.assisted_applications['order-1'].checkoutSessionStatus).toBe(payment_status === 'paid' ? 'completed' : 'creating');
    expect(store.assisted_applications['order-1'].paymentStatus).toBe(payment_status === 'paid' ? 'paid' : 'pending');
  });

  it.each(['unpaid', 'paid'])('protects a Stripe replacement lease while permitting %s confirmation', async (payment_status) => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();
    store.assisted_applications = { 'order-1': { paymentProvider: 'stripe', stripeCheckoutSessionId: 'old',
      paymentStatus: 'pending', checkoutSessionStatus: 'creating' } };
    await handleAssistedApplicationWebhookEvent({
      type: payment_status === 'paid' ? 'checkout.session.completed' : 'checkout.session.expired',
      data: { object: { id: 'old', amount_total: 199, currency: 'eur', payment_status,
        metadata: { product: 'assisted_application', orderId: 'order-1' },
      } },
    }, { db: firestore, ts: '__webhook_timestamp__' });
    expect(store.assisted_applications['order-1']).toMatchObject(payment_status === 'paid'
      ? { paymentStatus: 'paid', checkoutSessionStatus: 'completed' }
      : { paymentStatus: 'pending', checkoutSessionStatus: 'creating' });
  });

  it('marks an order paid only on the signed-webhook dispatch target', async () => {
    const { handleCreateAssistedApplicationCheckout, handleAssistedApplicationWebhookEvent } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());

    const handled = await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 199,
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

  it('allows a later SumUp success to upgrade a failed attempt on the same checkout', async () => {
    assistedApplicationPaymentProvider.mockResolvedValue('sumup');
    const {
      handleCreateAssistedApplicationCheckout,
      handleAssistedApplicationWebhookEvent,
    } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.async_payment_failed',
      data: {
        object: {
          id: 'sumup_checkout_1',
          amount_total: 199,
          currency: 'eur',
          payment_status: 'unpaid',
          metadata: {
            product: 'assisted_application',
            paymentProvider: 'sumup',
            orderId: 'order-1',
          },
          sumupTransactionId: 'sumup_failed_transaction',
        },
      },
    }, { db: firestore, ts: '__failed_timestamp__' });

    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'failed',
      submissionStatus: 'awaiting_payment',
    }));

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sumup_checkout_1',
          amount_total: 199,
          currency: 'eur',
          payment_status: 'paid',
          metadata: {
            product: 'assisted_application',
            paymentProvider: 'sumup',
            orderId: 'order-1',
          },
          sumupTransactionId: 'sumup_successful_transaction',
        },
      },
    }, { db: firestore, ts: '__paid_timestamp__' });

    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentProvider: 'sumup',
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      sumupCheckoutId: 'sumup_checkout_1',
      sumupTransactionId: 'sumup_successful_transaction',
      paidAt: '__paid_timestamp__',
      paymentFailureReason: null,
    }));
  });

  it('preserves a paid order when a stale failure event arrives later', async () => {
    const {
      handleCreateAssistedApplicationCheckout,
      handleAssistedApplicationWebhookEvent,
    } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 199,
          currency: 'eur',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__paid_timestamp__' });
    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_assisted_1',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__stale_timestamp__' });

    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      paidAt: '__paid_timestamp__',
      updatedAt: '__paid_timestamp__',
    }));
  });

  it('ignores an event for a session different from the persisted checkout attempt', async () => {
    const {
      handleCreateAssistedApplicationCheckout,
      handleAssistedApplicationWebhookEvent,
    } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());

    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_stale_session',
          amount_total: 199,
          currency: 'eur',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__stale_timestamp__' });

    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'pending',
      submissionStatus: 'awaiting_payment',
      stripeCheckoutSessionId: 'cs_assisted_1',
    }));
    expect(store.assisted_applications['order-1'].stripeSessionId).toBeUndefined();
  });

  it('does not promote a completed session whose Stripe payment is not paid', async () => {
    const { handleAssistedApplicationWebhookEvent } = await loadCheckout();

    const handled = await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_unpaid',
          amount_total: 199,
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
          amount_total: 199,
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

  it('keeps the queue open when Stripe reports only a partial charge refund', async () => {
    const { handleCreateAssistedApplicationCheckout, handleAssistedApplicationWebhookEvent } = await loadCheckout();
    await handleCreateAssistedApplicationCheckout(request());
    await handleAssistedApplicationWebhookEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_assisted_1',
          amount_total: 199,
          currency: 'eur',
          payment_status: 'paid',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__paid_timestamp__' });

    const handled = await handleAssistedApplicationWebhookEvent({
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_assisted_1',
          amount: 199,
          amount_refunded: 50,
          refunded: false,
          payment_intent: 'pi_assisted_1',
          metadata: { product: 'assisted_application', orderId: 'order-1' },
        },
      },
    }, { db: firestore, ts: '__partial_refund_timestamp__' });

    expect(handled).toBe(true);
    expect(store.assisted_applications['order-1']).toEqual(expect.objectContaining({
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
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
          amount_total: 199,
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
