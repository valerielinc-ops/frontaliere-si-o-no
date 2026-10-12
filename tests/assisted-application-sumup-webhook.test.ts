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
  retrieveSumUpCheckout: (...args: unknown[]) => mocks.retrieveSumUpCheckout(...args),
}));
vi.mock('../functions/src/applicationConciergeConstants.js', () => ({
  APPLICATION_CONCIERGE_PRODUCT: 'application_concierge',
  APPLICATION_CONCIERGE_SERVICES_COLLECTION: 'application_concierge_services',
}));
vi.mock('../functions/src/applicationConciergeCheckout.js', () => ({
  handleApplicationConciergeWebhookEvent: (...args: unknown[]) => mocks.handleApplicationConciergeWebhookEvent(...args),
}));

const { handleAssistedApplicationSumUpWebhook } = await import('../functions/src/assistedApplicationSumupWebhook.js');

function makeDb(
  order: Record<string, unknown> | null,
  service: Record<string, unknown> | null = null,
) {
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
      };
    },
  };
}

beforeEach(() => {
  mocks.db.mockReset();
  mocks.retrieveSumUpCheckout.mockReset();
  mocks.handleAssistedApplicationWebhookEvent.mockReset();
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
      amount: 0.99,
      currency: 'EUR',
      status: 'PAID',
      transactions: [{ id: 'sumup_transaction_1', transaction_code: 'TX1' }],
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
      amount_total: 99,
      currency: 'eur',
      payment_status: 'paid',
      client_reference_id: 'order-1',
      customer_email: 'candidate@example.test',
      sumupTransactionId: 'sumup_transaction_1',
      sumupTransactionCode: 'TX1',
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
      amount: 0.99,
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
});
