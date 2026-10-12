import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  retrieveSumUpCheckout: vi.fn(),
  handleAssistedApplicationWebhookEvent: vi.fn(),
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

const { handleAssistedApplicationSumUpWebhook } = await import('../functions/src/assistedApplicationSumupWebhook.js');

function makeDb(order: Record<string, unknown> | null) {
  return {
    collection: (name: string) => {
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
});
