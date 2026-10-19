import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  retrieveSumUpCheckout: vi.fn(),
  handleAssistedApplicationWebhookEvent: vi.fn(),
  handleApplicationConciergeWebhookEvent: vi.fn(),
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__timestamp__' },
}));
vi.mock('../functions/src/stripePublisherCore.js', () => ({
  db: () => mocks.db(),
}));
vi.mock('../functions/src/assistedApplicationCheckout.js', () => ({
  ASSISTED_APPLICATION_PRODUCT: 'assisted_application',
  handleAssistedApplicationWebhookEvent: (...args: unknown[]) => mocks.handleAssistedApplicationWebhookEvent(...args),
}));
vi.mock('../functions/src/sumupAssistedApplicationCore.js', () => ({
  SUMUP_PAYMENT_PROVIDER: 'sumup',
  latestSumUpTransaction: (checkout: { transactions?: Array<Record<string, unknown>> }) => (
    [...(checkout.transactions || [])].sort((left, right) => (
      Date.parse(String(right.timestamp || '')) - Date.parse(String(left.timestamp || ''))
    ))[0] || null
  ),
  retrieveSumUpCheckout: (...args: unknown[]) => mocks.retrieveSumUpCheckout(...args),
}));
vi.mock('../functions/src/applicationConciergeConstants.js', () => ({
  APPLICATION_CONCIERGE_PRODUCT: 'application_concierge',
  APPLICATION_CONCIERGE_SERVICES_COLLECTION: 'application_concierge_services',
}));
vi.mock('../functions/src/applicationConciergeCheckout.js', () => ({
  handleApplicationConciergeWebhookEvent: (...args: unknown[]) => mocks.handleApplicationConciergeWebhookEvent(...args),
}));

const {
  handleAssistedApplicationSumUpWebhook,
  runAssistedApplicationSumUpReconciliation,
} = await import('../functions/src/assistedApplicationSumupWebhook.js');

function makeDb(
  order: Record<string, unknown> | null,
  service: Record<string, unknown> | null = null,
  candidateDocs: {
    assisted?: Array<{ id: string; data: () => Record<string, unknown> }>;
    concierge?: Array<{ id: string; data: () => Record<string, unknown> }>;
  } = {},
) {
  function paginatedQuery(docs: Array<{ id: string; data: () => Record<string, unknown> }>) {
    let offset = 0;
    let pageSize = docs.length || 100;
    const query = {
      orderBy: () => query,
      limit: (value: number) => {
        pageSize = value;
        return query;
      },
      startAfter: (lastDoc: { id: string }) => {
        offset = docs.findIndex((doc) => doc.id === lastDoc.id) + 1;
        return query;
      },
      get: async () => ({ docs: docs.slice(offset, offset + pageSize) }),
    };
    return query;
  }

  const assistedCandidateDocs = candidateDocs.assisted || (
    order ? [{ id: 'order-1', data: () => order }] : []
  );
  const conciergeCandidateDocs = candidateDocs.concierge || (
    service ? [{ id: 'service-1', data: () => service }] : []
  );
  return {
    collection: (name: string) => {
      if (name === 'application_concierge_services') {
        return {
          doc: () => ({
            get: async () => ({
              exists: service != null,
              data: () => service,
            }),
          }),
          where: () => paginatedQuery(conciergeCandidateDocs),
        };
      }
      expect(name).toBe('assisted_applications');
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: order != null,
            data: () => order,
          }),
        }),
        where: () => paginatedQuery(assistedCandidateDocs),
      };
    },
  };
}

beforeEach(() => {
  mocks.db.mockReset();
  mocks.retrieveSumUpCheckout.mockReset();
  mocks.handleAssistedApplicationWebhookEvent.mockReset();
  mocks.handleAssistedApplicationWebhookEvent.mockResolvedValue(true);
  mocks.handleApplicationConciergeWebhookEvent.mockReset();
});

describe('SumUp assisted-application webhook', () => {
  it('retrieves and dispatches a paid checkout only for its own pending order', async () => {
    mocks.db.mockReturnValue(makeDb({
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_checkout_1',
      paymentStatus: 'pending',
      customerEmail: 'candidate@example.test',
    }));
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup_checkout_1',
      checkout_reference: 'order-1',
      amount: 1.99,
      currency: 'EUR',
      status: 'PAID',
      transactions: [
        { id: 'sumup_transaction_success', transaction_code: 'SUCCESS', timestamp: '2026-10-12T12:22:48.309Z' },
        { id: 'sumup_transaction_failed', transaction_code: 'FAILED', timestamp: '2026-10-12T12:21:25.969Z' },
      ],
    });

    const result = await handleAssistedApplicationSumUpWebhook({
      method: 'POST',
      body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: 'sumup_checkout_1' },
    });

    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(mocks.retrieveSumUpCheckout).toHaveBeenCalledWith('sumup_checkout_1');
    expect(mocks.handleAssistedApplicationWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checkout.session.completed' }),
      expect.objectContaining({ ts: '__timestamp__' }),
    );
    expect(mocks.handleAssistedApplicationWebhookEvent.mock.calls[0][0].data.object).toEqual(expect.objectContaining({
      amount_total: 199,
      currency: 'eur',
      payment_status: 'paid',
      client_reference_id: 'order-1',
      customer_email: 'candidate@example.test',
      sumupTransactionId: 'sumup_transaction_success',
      sumupTransactionCode: 'SUCCESS',
      metadata: {
        product: 'assisted_application',
        paymentProvider: 'sumup',
        orderId: 'order-1',
      },
    }));
  });

  it('acknowledges callbacks for another checkout without touching an order', async () => {
    mocks.db.mockReturnValue(makeDb({
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: 'cs_stripe',
    }));
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup_checkout_1',
      checkout_reference: 'order-1',
      amount: 1.99,
      currency: 'EUR',
      status: 'PAID',
    });

    await expect(handleAssistedApplicationSumUpWebhook({
      method: 'POST',
      body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: 'sumup_checkout_1' },
    })).resolves.toEqual({ status: 200, body: { received: true, ignored: true } });
    expect(mocks.handleAssistedApplicationWebhookEvent).not.toHaveBeenCalled();
  });

  it('dispatches the 39.99 EUR checkout to the concierge parent ledger', async () => {
    mocks.db.mockReturnValue(makeDb(null, {
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_concierge_1',
      paymentStatus: 'pending',
    }));
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup_concierge_1',
      checkout_reference: 'service-1',
      amount: 39.99,
      currency: 'EUR',
      status: 'PAID',
      transactions: [{ id: 'sumup_transaction_concierge' }],
    });

    await expect(handleAssistedApplicationSumUpWebhook({
      method: 'POST',
      body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: 'sumup_concierge_1' },
    })).resolves.toEqual({ status: 200, body: { received: true } });

    expect(mocks.handleApplicationConciergeWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'checkout.session.completed',
        data: expect.objectContaining({
          object: expect.objectContaining({
            amount_total: 3999,
            client_reference_id: 'service-1',
            metadata: expect.objectContaining({
              product: 'application_concierge',
              serviceId: 'service-1',
            }),
          }),
        }),
      }),
      expect.objectContaining({ ts: '__timestamp__' }),
    );
    expect(mocks.handleAssistedApplicationWebhookEvent).not.toHaveBeenCalled();
  });

  it('reconciles a recent provider-paid checkout when the callback was missed', async () => {
    const order = {
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_checkout_1',
      paymentStatus: 'failed',
      createdAt: new Date('2026-10-12T12:21:15.119Z'),
    };
    const firestore = makeDb(order);
    mocks.db.mockReturnValue(firestore);
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup_checkout_1',
      checkout_reference: 'order-1',
      amount: 1.99,
      currency: 'EUR',
      status: 'PAID',
      transactions: [{ id: 'sumup_transaction_success', timestamp: '2026-10-12T12:22:48.309Z' }],
    });

    await expect(runAssistedApplicationSumUpReconciliation({
      db: () => firestore,
      retrieve: mocks.retrieveSumUpCheckout,
      nowMs: Date.parse('2026-10-19T12:00:00Z'),
      ts: '__reconciliation_timestamp__',
    })).resolves.toEqual({
      candidates: 1,
      inspected: 1,
      promoted: 1,
      skipped: 0,
      errors: 0,
    });
    expect(mocks.handleAssistedApplicationWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('reconciles a missed concierge callback', async () => {
    const service = {
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_concierge_1',
      paymentStatus: 'pending',
      serviceStatus: 'awaiting_payment',
      createdAt: new Date('2026-10-12T12:21:15.119Z'),
    };
    const firestore = makeDb(null, service, {
      concierge: [{ id: 'service-1', data: () => service }],
    });
    mocks.db.mockReturnValue(firestore);
    mocks.retrieveSumUpCheckout.mockResolvedValue({
      id: 'sumup_concierge_1',
      checkout_reference: 'service-1',
      amount: 39.99,
      currency: 'EUR',
      status: 'PAID',
    });

    await expect(runAssistedApplicationSumUpReconciliation({
      db: () => firestore,
      retrieve: mocks.retrieveSumUpCheckout,
      nowMs: Date.parse('2026-10-19T12:00:00Z'),
      ts: '__reconciliation_timestamp__',
    })).resolves.toEqual({
      candidates: 1,
      inspected: 1,
      promoted: 1,
      skipped: 0,
      errors: 0,
    });
    expect(mocks.handleApplicationConciergeWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('paginates beyond the first 100 candidates', async () => {
    const targetOrder = {
      paymentProvider: 'sumup',
      sumupCheckoutId: 'sumup_checkout_101',
      paymentStatus: 'pending',
      createdAt: new Date('2026-10-12T12:21:15.119Z'),
    };
    const candidateDocs = Array.from({ length: 101 }, (_, index) => {
      const id = `order-${index + 1}`;
      const checkoutId = `sumup_checkout_${index + 1}`;
      const data = index === 100 ? targetOrder : {
        paymentProvider: 'sumup',
        sumupCheckoutId: checkoutId,
        paymentStatus: 'pending',
        createdAt: new Date('2026-10-12T12:21:15.119Z'),
      };
      return { id, data: () => data };
    });
    const firestore = makeDb(targetOrder, null, { assisted: candidateDocs });
    mocks.db.mockReturnValue(firestore);
    mocks.retrieveSumUpCheckout.mockImplementation(async (checkoutId: string) => (
      checkoutId === 'sumup_checkout_101'
        ? {
          id: checkoutId,
          checkout_reference: 'order-101',
      amount: 1.99,
          currency: 'EUR',
          status: 'PAID',
        }
        : {
          id: checkoutId,
          checkout_reference: 'unpaid-order',
      amount: 1.99,
          currency: 'EUR',
          status: 'PENDING',
        }
    ));

    await expect(runAssistedApplicationSumUpReconciliation({
      db: () => firestore,
      retrieve: mocks.retrieveSumUpCheckout,
      nowMs: Date.parse('2026-10-19T12:00:00Z'),
      ts: '__reconciliation_timestamp__',
    })).resolves.toEqual({
      candidates: 101,
      inspected: 101,
      promoted: 1,
      skipped: 100,
      errors: 0,
    });
  });
});
