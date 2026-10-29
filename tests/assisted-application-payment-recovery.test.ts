import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  defaultDb: null as any,
  getStripe: vi.fn(),
  verifyCaller: vi.fn(),
  retrieveSumUpCheckout: vi.fn(),
  createSumUpAssistedApplicationCheckout: vi.fn(),
  applyAssistedApplicationSumUpCheckout: vi.fn(),
  handleAssistedApplicationWebhookEvent: vi.fn(),
  postingClosedForOrder: vi.fn(),
  sendPendingPaymentDigest: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__server_timestamp__' },
}));

vi.mock('../functions/src/stripePublisherCore.js', () => ({
  db: mocks.defaultDb,
  getStripe: mocks.getStripe,
  verifyCaller: mocks.verifyCaller,
}));

vi.mock('../functions/src/assistedApplicationCheckout.js', () => ({
  ASSISTED_APPLICATION_CURRENCY: 'eur',
  ASSISTED_APPLICATION_PRODUCT: 'assisted_application',
  handleAssistedApplicationWebhookEvent: mocks.handleAssistedApplicationWebhookEvent,
}));

vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  createSumUpAssistedApplicationCheckout: mocks.createSumUpAssistedApplicationCheckout,
  retrieveSumUpCheckout: mocks.retrieveSumUpCheckout,
  SUMUP_PAYMENT_PROVIDER: 'sumup',
}));

vi.mock('../functions/src/assistedApplicationSumupWebhook.js', () => ({
  applyAssistedApplicationSumUpCheckout: mocks.applyAssistedApplicationSumUpCheckout,
}));

vi.mock('../functions/src/assistedApplicationAutomation.js', () => ({
  postingClosedForOrder: mocks.postingClosedForOrder,
}));

vi.mock('../functions/src/lib/emailSuppression.js', () => ({
  isCrossChannelStop: () => false,
}));

vi.mock('../functions/src/assistedApplicationNotifications.js', () => ({
  buildOrderPageUrl: (_order: Row, orderId: string) => `https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_order_id=${orderId}`,
  customerEmailFor: (order: Row) => String(order.applicantEmail || order.customerEmail || '').toLowerCase(),
  paymentRecoveryDigestId: (_userId: string, orderIds: string[], stage: number) => `digest-${orderIds.join('-')}-${stage}`,
  sendPendingPaymentDigest: mocks.sendPendingPaymentDigest,
}));

function deepMerge(target: Row, source: Row): Row {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
      ? deepMerge(result[key] && typeof result[key] === 'object' ? result[key] : {}, value)
      : value;
  }
  return result;
}

function makeDb(initial: Record<string, Record<string, Row>> = {}) {
  const store = initial;
  const refFor = (collectionName: string, id: string) => ({
    id,
    async get() {
      const data = store[collectionName]?.[id];
      return { id, exists: data != null, data: () => data };
    },
    async set(data: Row, options?: { merge?: boolean }) {
      store[collectionName] ||= {};
      store[collectionName][id] = options?.merge
        ? deepMerge(store[collectionName][id] || {}, data)
        : data;
    },
  });
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return refFor(name, id);
        },
        where(field: string, operator: string, value: unknown) {
          return {
            async get() {
              expect(operator).toBe('==');
              const docs = Object.entries(store[name] || {})
                .filter(([, data]) => data?.[field] === value)
                .map(([id, data]) => ({ id, data: () => data, ref: refFor(name, id) }));
              return { docs };
            },
          };
        },
      };
    },
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: Row, options?: { merge?: boolean }) => ref.set(data, options),
      });
    },
    store,
  };
  return db;
}

const NOW = Date.parse('2026-10-21T10:00:00Z');
const HOUR = 60 * 60 * 1000;

function pendingOrder(orderId: string, overrides: Row = {}): Row {
  return {
    orderId,
    userId: 'user-1',
    applicantEmail: 'candidate@example.test',
    applicantName: 'Candidate Test',
    jobId: `job-${orderId}`,
    jobTitle: `Role ${orderId}`,
    companyName: 'Example SA',
    jobUrl: 'https://jobs.example.test/role',
    paymentStatus: 'pending',
    submissionStatus: 'awaiting_payment',
    paymentProvider: 'stripe',
    stripeCheckoutSessionId: `cs-${orderId}`,
    createdAt: new Date(NOW - 3 * HOUR),
    ...overrides,
  };
}

const recovery = await import('../functions/src/assistedApplicationPaymentRecovery.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaultDb = makeDb();
  mocks.postingClosedForOrder.mockResolvedValue(false);
  mocks.verifyCaller.mockResolvedValue({ uid: 'user-1' });
  mocks.getStripe.mockResolvedValue({});
  mocks.retrieveSumUpCheckout.mockResolvedValue({});
  mocks.createSumUpAssistedApplicationCheckout.mockResolvedValue({ id: 'sumup-new' });
  mocks.applyAssistedApplicationSumUpCheckout.mockResolvedValue({ paymentStatus: 'paid' });
  mocks.handleAssistedApplicationWebhookEvent.mockResolvedValue(true);
  mocks.sendPendingPaymentDigest.mockResolvedValue({ ok: true, provider: 'mailgun', messageId: 'msg-1' });
});

describe('assisted-application payment recovery policy', () => {
  it('aggregates one user’s orders and schedules at most one follow-up per order', () => {
    const orders = [
      pendingOrder('order-new'),
      pendingOrder('order-old', { createdAt: new Date(NOW - 4 * HOUR) }),
      pendingOrder('other-user', { userId: 'user-2', applicantEmail: 'other@example.test' }),
    ];
    const groups = recovery.groupPendingPaymentOrders(orders);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.userId === 'user-1')?.orders.map((order) => order.orderId))
      .toEqual(['order-new', 'order-old']);

    expect(recovery.pendingPaymentRecoveryDueStage({}, groups[0].orders, {
      nowMs: NOW,
      initialDelayMs: 2 * HOUR,
    })).toBe(1);
    expect(recovery.pendingPaymentRecoveryDueStage({
      orders: {
        'order-old': { reminderCount: 1, lastSentAt: new Date(NOW - 49 * HOUR) },
        'order-new': { reminderCount: 2, lastSentAt: new Date(NOW - 100 * HOUR) },
      },
    }, groups[0].orders, { nowMs: NOW })).toBe(2);
    expect(recovery.pendingPaymentRecoveryDueStage({
      orders: { 'order-old': { reminderCount: 2, lastSentAt: new Date(NOW - 100 * HOUR) } },
    }, [groups[0].orders.find((order) => order.orderId === 'order-old')!], { nowMs: NOW })).toBe(0);
  });

  it('sends one digest for a due user group and keeps provider checks per order', async () => {
    const db = makeDb({
      assisted_applications: {
        'order-a': pendingOrder('order-a'),
        'order-b': pendingOrder('order-b'),
      },
    });
    const inspectPayment = vi.fn(async () => ({ status: 'open' as const }));

    const summary = await recovery.runAssistedApplicationPaymentRecoverySweep({
      db,
      nowMs: NOW,
      getStripeClient: vi.fn(async () => ({})),
      inspectPayment,
      postingClosed: mocks.postingClosedForOrder,
    });

    expect(summary.candidates).toBe(2);
    expect(summary.groups).toBe(1);
    expect(summary.sent).toBe(1);
    expect(inspectPayment).toHaveBeenCalledTimes(2);
    expect(mocks.sendPendingPaymentDigest).toHaveBeenCalledTimes(1);
    expect(mocks.sendPendingPaymentDigest.mock.calls[0][0].orders.map((order: Row) => order.orderId))
      .toEqual(['order-a', 'order-b']);
  });

  it('reconciles a paid Stripe checkout instead of emailing a pending reminder', async () => {
    const order = pendingOrder('order-paid');
    const applyStripe = vi.fn(async () => true);
    const result = await recovery.inspectPendingAssistedApplicationPayment({
      db: makeDb(),
      orderId: order.orderId,
      order,
      stripe: {},
      retrieveStripe: vi.fn(async () => ({
        id: order.stripeCheckoutSessionId,
        status: 'complete',
        payment_status: 'paid',
        amount_total: 199,
        currency: 'eur',
        client_reference_id: order.orderId,
        metadata: { product: 'assisted_application', orderId: order.orderId },
      })),
      applyStripe,
    });

    expect(result).toEqual({ status: 'paid' });
    expect(applyStripe).toHaveBeenCalledOnce();
  });

  it('reconciles a paid SumUp checkout with the handler database factory', async () => {
    const order = pendingOrder('order-sumup-paid', {
      paymentProvider: 'sumup',
      stripeCheckoutSessionId: null,
      sumupCheckoutId: 'sumup-paid',
    });
    const db = makeDb();
    const applySumUp = vi.fn(async (_checkout: Row, context: { db: () => unknown }) => {
      expect(typeof context.db).toBe('function');
      expect(context.db()).toBe(db);
      return { paymentStatus: 'paid' };
    });
    const result = await recovery.inspectPendingAssistedApplicationPayment({
      db,
      orderId: order.orderId,
      order,
      retrieveSumUp: vi.fn(async () => ({
        id: order.sumupCheckoutId,
        checkout_reference: order.orderId,
        status: 'PAID',
      })),
      applySumUp,
    });

    expect(result).toEqual({ status: 'paid' });
    expect(applySumUp).toHaveBeenCalledOnce();
  });

  it('creates a replacement session only after an explicit provider expiry', async () => {
    const order = pendingOrder('order-expired', { stripeRequestKey: 'initial-checkout-key' });
    const db = makeDb({ assisted_applications: { [order.orderId]: order } });
    const create = vi.fn(async () => ({ id: 'cs-replacement', url: 'https://checkout.stripe.test/replacement' }));
    const result = await recovery.inspectPendingAssistedApplicationPayment({
      db,
      orderId: order.orderId,
      order,
      nowMs: NOW,
      stripe: { checkout: { sessions: { create } } },
      retrieveStripe: vi.fn(async () => ({ id: order.stripeCheckoutSessionId, status: 'expired' })),
    });

    expect(result.status).toBe('renewed');
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1].idempotencyKey).toBe('assisted-application:recovery:order-expired:2');
    expect(db.store.assisted_applications[order.orderId].stripeCheckoutSessionId).toBe('cs-replacement');
  });

  it('renews an expired SumUp checkout through the same provider path', async () => {
    const order = pendingOrder('order-sumup-expired', {
      paymentProvider: 'sumup',
      stripeCheckoutSessionId: null,
      sumupCheckoutId: 'sumup-old',
    });
    const db = makeDb({ assisted_applications: { [order.orderId]: order } });
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup-old',
      checkout_reference: order.orderId,
      status: 'EXPIRED',
    });
    const result = await recovery.inspectPendingAssistedApplicationPayment({
      db,
      orderId: order.orderId,
      order,
      nowMs: NOW,
    });

    expect(result).toMatchObject({ status: 'renewed', checkoutId: 'sumup-new' });
    expect(mocks.createSumUpAssistedApplicationCheckout).toHaveBeenCalledWith({
      orderId: order.orderId,
      redirectUrl: expect.stringContaining(order.orderId),
    });
    expect(db.store.assisted_applications[order.orderId].sumupCheckoutId).toBe('sumup-new');
  });

  it.each(['open', 'renewed'])('returns a client-compatible SumUp checkout for %s recovery', async (status) => {
    const order = pendingOrder('order-resume', { paymentProvider: 'sumup', sumupCheckoutId: 'sumup-existing' });
    const result = await recovery.handleResumeAssistedApplicationPayment({
      method: 'POST', body: { orderId: order.orderId },
    }, {
      db: makeDb({ assisted_applications: { [order.orderId]: order } }),
      postingClosed: mocks.postingClosedForOrder,
      inspectPayment: vi.fn(async () => ({ status, checkoutId: 'sumup-renewed' })),
    });
    expect(result).toEqual({ status: 200, body: {
      ok: true, status: 'open', paymentProvider: 'sumup', orderId: order.orderId,
      checkoutId: status === 'open' ? 'sumup-existing' : 'sumup-renewed',
    } });
  });

  it.each(['open', 'renewed'])('returns a client-compatible Stripe URL for %s recovery', async (status) => {
    const order = pendingOrder('order-resume');
    const result = await recovery.handleResumeAssistedApplicationPayment({
      method: 'POST', body: { orderId: order.orderId },
    }, {
      db: makeDb({ assisted_applications: { [order.orderId]: order } }),
      postingClosed: mocks.postingClosedForOrder,
      inspectPayment: vi.fn(async () => ({ status, session: { url: 'https://checkout.stripe.com/test/' } })),
    });
    expect(result).toEqual({ status: 200, body: {
      ok: true, status: 'open', paymentProvider: 'stripe', orderId: order.orderId,
      url: 'https://checkout.stripe.com/test/',
    } });
  });

  it('does not resume an order for a different Firebase user', async () => {
    const order = pendingOrder('order-for-someone-else', { userId: 'other-user' });
    const db = makeDb({ assisted_applications: { [order.orderId]: order } });
    const result = await recovery.handleResumeAssistedApplicationPayment({
      method: 'POST',
      body: { orderId: order.orderId },
    }, { db, postingClosed: mocks.postingClosedForOrder });

    expect(result).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
  });
});
