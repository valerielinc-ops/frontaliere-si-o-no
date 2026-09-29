/**
 * tests/consulting-core.test.ts
 *
 * Coverage for functions/src/consultingCore.js — one-time consulting-session
 * payment (replaces the dead Calendly booking links on /consulenza/, see
 * AGENTS-HISTORY). Fully separate domain from stripePublisherCore.js /
 * stripeReaderCore.js: public/anonymous checkout (no verifyCaller), `payment`
 * mode (one-time, not subscription), own Firestore collection
 * (consulting_orders, doc id = Stripe Checkout Session id).
 *
 * Mocking strategy (mirrors tests/stripe-reader-core.test.ts):
 * - functions/src/remoteConfigSecrets.js: getRemoteConfigValue +
 *   bridgeEmailCascadeCredentialsToEnv mocks.
 * - functions/src/emailCascade.js: sendEmailCascade / PROVIDERS /
 *   isProviderConfigured mocks.
 * - stripe (npm package): mocked checkout.sessions.create.
 * consultingCore.js never touches firebase-admin directly (handleCreateConsultingCheckout
 * only needs getStripe(), which only reads STRIPE_PRICE_* via Remote Config;
 * handleConsultingWebhookEvent/handleConsultingDetailsSubmitted are pure
 * functions taking db/ts or before/after as plain arguments), so no
 * firebase-admin mock is needed here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { matchBlock } from './helpers/firestoreRulesBlock';

const getRemoteConfigValueMock = vi.fn(async (key: string) => {
  if (key === 'STRIPE_SECRET_KEY') return 'sk_test_fake';
  if (key === 'STRIPE_PRICE_CONSULTING_BASE') return 'price_consulting_base_test';
  if (key === 'STRIPE_PRICE_CONSULTING_PREMIUM') return 'price_consulting_premium_test';
  return '';
});
const bridgeEmailCascadeCredentialsToEnvMock = vi.fn(async () => {});

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => getRemoteConfigValueMock(key),
  bridgeEmailCascadeCredentialsToEnv: () => bridgeEmailCascadeCredentialsToEnvMock(),
}));

const sendEmailCascadeMock = vi.fn(async (emails: unknown[]) => ({ sent: emails, failed: [] }));
let providersConfigured = true;

vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: (...args: unknown[]) => sendEmailCascadeMock(...args),
  PROVIDERS: [{ id: 'resend' }],
  isProviderConfigured: () => providersConfigured,
}));

const stripeCheckoutSessionsCreate = vi.fn(async () => ({
  id: 'cs_test_consulting_1',
  url: 'https://checkout.stripe.com/cs_test_consulting_1',
}));

vi.mock('stripe', () => {
  class MockStripe {
    checkout = { sessions: { create: stripeCheckoutSessionsCreate } };
  }
  return { default: MockStripe };
});

async function load() {
  return import('../functions/src/consultingCore.js');
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: {
      tier: 'base',
      successUrl: 'https://frontaliereticino.ch/consulenza/?consulting_checkout=success',
      cancelUrl: 'https://frontaliereticino.ch/consulenza/',
      locale: 'it',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  providersConfigured = true;
  getRemoteConfigValueMock.mockImplementation(async (key: string) => {
    if (key === 'STRIPE_SECRET_KEY') return 'sk_test_fake';
    if (key === 'STRIPE_PRICE_CONSULTING_BASE') return 'price_consulting_base_test';
    if (key === 'STRIPE_PRICE_CONSULTING_PREMIUM') return 'price_consulting_premium_test';
    return '';
  });
  sendEmailCascadeMock.mockImplementation(async (emails: unknown[]) => ({ sent: emails, failed: [] }));
  stripeCheckoutSessionsCreate.mockImplementation(async () => ({
    id: 'cs_test_consulting_1',
    url: 'https://checkout.stripe.com/cs_test_consulting_1',
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateConsultingCheckout', () => {
  it('rejects non-POST', async () => {
    const { handleCreateConsultingCheckout } = await load();
    const res = await handleCreateConsultingCheckout(req({ method: 'GET' }));
    expect(res).toEqual({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('rejects an invalid tier', async () => {
    const { handleCreateConsultingCheckout } = await load();
    const res = await handleCreateConsultingCheckout(req({ body: { ...req().body, tier: 'gold' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_tier' } });
  });

  it('rejects non-https redirect URLs', async () => {
    const { handleCreateConsultingCheckout } = await load();
    const res = await handleCreateConsultingCheckout(
      req({ body: { ...req().body, successUrl: 'http://not-secure.test' } }),
    );
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_redirect_urls' } });
  });

  it('500s cleanly when the price is not configured in Remote Config', async () => {
    getRemoteConfigValueMock.mockImplementation(async () => '');
    const { handleCreateConsultingCheckout } = await load();
    const res = await handleCreateConsultingCheckout(req());
    expect(res).toEqual({ status: 500, body: { ok: false, error: 'consulting_price_not_configured' } });
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('creates a one-time (payment mode) Checkout Session for the base tier, no auth required', async () => {
    const { handleCreateConsultingCheckout } = await load();
    const res = await handleCreateConsultingCheckout(req());
    expect(res).toEqual({
      status: 200,
      body: { ok: true, url: 'https://checkout.stripe.com/cs_test_consulting_1' },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_consulting_base_test', quantity: 1 }],
        metadata: { product: 'consulting', tier: 'base', locale: 'it' },
      }),
    );
  });

  it('uses the premium price id for the premium tier', async () => {
    const { handleCreateConsultingCheckout } = await load();
    await handleCreateConsultingCheckout(req({ body: { ...req().body, tier: 'premium' } }));
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_consulting_premium_test', quantity: 1 }],
        metadata: { product: 'consulting', tier: 'premium', locale: 'it' },
      }),
    );
  });
});

describe('handleConsultingWebhookEvent', () => {
  const ts = '__ts__';
  function fakeDb(initial: Record<string, Record<string, unknown>> = {}) {
    const store = initial;
    const dbFn = () => ({
      collection: () => ({
        doc: (id: string) => ({
          set: async (data: Record<string, unknown>) => {
            store[id] = { ...(store[id] || {}), ...data };
          },
        }),
      }),
    });
    return { dbFn, store };
  }

  it('ignores events that are not checkout.session.completed', async () => {
    const { handleConsultingWebhookEvent } = await load();
    const { dbFn } = fakeDb();
    const handled = await handleConsultingWebhookEvent({ type: 'invoice.paid', data: { object: {} } }, { db: dbFn, ts });
    expect(handled).toBe(false);
  });

  it('ignores checkout.session.completed for a different product (e.g. reader/publisher)', async () => {
    const { handleConsultingWebhookEvent } = await load();
    const { dbFn, store } = fakeDb();
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_other', metadata: { plan: 'reader_noads' } } },
    };
    const handled = await handleConsultingWebhookEvent(event, { db: dbFn, ts });
    expect(handled).toBe(false);
    expect(store.cs_other).toBeUndefined();
  });

  it('writes a paid consulting_orders doc keyed by the Checkout Session id', async () => {
    const { handleConsultingWebhookEvent } = await load();
    const { dbFn, store } = fakeDb();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_consulting_1',
          amount_total: 4900,
          currency: 'chf',
          customer_details: { email: 'client@example.com' },
          metadata: { product: 'consulting', tier: 'base', locale: 'it' },
        },
      },
    };
    const handled = await handleConsultingWebhookEvent(event, { db: dbFn, ts });
    expect(handled).toBe(true);
    expect(store.cs_test_consulting_1).toEqual({
      tier: 'base',
      locale: 'it',
      status: 'paid',
      amountTotal: 4900,
      currency: 'chf',
      customerEmail: 'client@example.com',
      stripeSessionId: 'cs_test_consulting_1',
      detailsSubmitted: false,
      createdAt: ts,
    });
  });

  it('defaults to the base tier when metadata.tier is missing/unrecognized', async () => {
    const { handleConsultingWebhookEvent } = await load();
    const { dbFn, store } = fakeDb();
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', metadata: { product: 'consulting' } } },
    };
    await handleConsultingWebhookEvent(event, { db: dbFn, ts });
    expect(store.cs_x.tier).toBe('base');
  });
});

describe('handleConsultingDetailsSubmitted', () => {
  const paidOrder = {
    tier: 'premium',
    status: 'paid',
    customerEmail: 'client@example.com',
    contactName: 'Mario Rossi',
    contactPhone: '+41 79 000 00 00',
    topic: 'consulting.intake.topic.fiscal',
    description: 'Situazione fiscale complessa con permesso G.',
    preferredDateStart: '2026-08-01',
    preferredDateEnd: '2026-08-10',
    preferredTimeWindow: ['morning', 'afternoon'],
    stripeSessionId: 'cs_test_consulting_1',
    detailsSubmitted: true,
  };

  it('skips (no email send) when detailsSubmitted did not just turn true', async () => {
    const { handleConsultingDetailsSubmitted } = await load();
    const res = await handleConsultingDetailsSubmitted(null, { ...paidOrder, detailsSubmitted: false });
    expect(res).toEqual({ ok: true, skipped: 'not_submitted' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('skips when already notified (before.detailsSubmitted was already true)', async () => {
    const { handleConsultingDetailsSubmitted } = await load();
    const res = await handleConsultingDetailsSubmitted(paidOrder, paidOrder);
    expect(res).toEqual({ ok: true, skipped: 'already_notified' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('returns an error when no email provider is configured', async () => {
    providersConfigured = false;
    const { handleConsultingDetailsSubmitted } = await load();
    const res = await handleConsultingDetailsSubmitted({ ...paidOrder, detailsSubmitted: false }, paidOrder);
    expect(res).toEqual({ ok: false, error: 'no_email_provider_configured' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('sends both a customer confirmation and an internal notification email', async () => {
    const { handleConsultingDetailsSubmitted } = await load();
    const res = await handleConsultingDetailsSubmitted({ ...paidOrder, detailsSubmitted: false }, paidOrder);
    expect(res).toEqual({ ok: true });
    expect(bridgeEmailCascadeCredentialsToEnvMock).toHaveBeenCalled();
    expect(sendEmailCascadeMock).toHaveBeenCalledTimes(1);
    const [emails] = sendEmailCascadeMock.mock.calls[0];
    expect(emails).toHaveLength(2);
    expect(emails[0].payload.to).toBe('client@example.com');
    expect(emails[1].payload.to).toBe('consulenza@frontaliereticino.ch');
    expect(emails[1].payload.html).toContain('cs_test_consulting_1');
  });

  it('propagates a send failure as a structured error', async () => {
    sendEmailCascadeMock.mockImplementation(async () => ({ sent: [], failed: [{ error: 'quota_exceeded' }] }));
    const { handleConsultingDetailsSubmitted } = await load();
    const res = await handleConsultingDetailsSubmitted({ ...paidOrder, detailsSubmitted: false }, paidOrder);
    expect(res).toEqual({ ok: false, error: 'send_failed:quota_exceeded' });
  });
});

describe('handleConsultingOrderPaid', () => {
  function fakeDb(initial: Record<string, any>) {
    const docs: Record<string, any> = { ...initial };
    const ref = (id: string) => ({
      id,
      async get() { return { exists: docs[id] != null, data: () => docs[id] }; },
      async set(data: any, options?: { merge?: boolean }) { docs[id] = options?.merge ? { ...(docs[id] || {}), ...data } : data; },
    });
    return {
      docs,
      collection: (name: string) => {
        expect(name).toBe('consulting_orders');
        return {
          doc: ref,
          where: (field: string, _op: string, value: unknown) => ({
            async get() {
              return {
                docs: Object.entries(docs)
                  .filter(([, data]) => data?.[field] === value)
                  .map(([id, data]) => ({ id, data: () => data })),
              };
            },
          }),
        };
      },
      runTransaction: async (callback: any) => callback({
        get: (r: any) => r.get(),
        set: (r: any, data: any, options?: { merge?: boolean }) => r.set(data, options),
      }),
    };
  }

  const paid = { tier: 'base', status: 'paid', locale: 'fr', customerEmail: 'client@example.com', detailsSubmitted: false };

  it('emails the customer the localized intake link and the internal inbox, once', async () => {
    const { handleConsultingOrderPaid, consultingIntakeUrl } = await load();
    const db = fakeDb({ cs_1: paid });

    const first = await handleConsultingOrderPaid(null, paid, 'cs_1', { db });
    const again = await handleConsultingOrderPaid(null, paid, 'cs_1', { db });

    expect(first).toEqual({ ok: true });
    expect(again).toEqual({ ok: true, skipped: 'already_notified' });
    expect(sendEmailCascadeMock).toHaveBeenCalledTimes(1);
    const [customer, internal] = (sendEmailCascadeMock.mock.calls[0][0] as any[]).map((email) => email.payload);
    expect(customer.to).toBe('client@example.com');
    expect(customer.subject).toContain('Paiement reçu');
    expect(customer.html).toContain(consultingIntakeUrl('cs_1', 'fr').replace(/&/g, '&amp;'));
    expect(consultingIntakeUrl('cs_1', 'fr')).toBe('https://frontaliereticino.ch/fr/consultation/?consulting_checkout=success&session_id=cs_1');
    expect(internal.to).toBe('consulenza@frontaliereticino.ch');
    expect(internal.replyTo).toBe('client@example.com');
  });

  it('releases the claim when the provider fails so a retry can send', async () => {
    const { handleConsultingOrderPaid } = await load();
    const db = fakeDb({ cs_2: paid });
    sendEmailCascadeMock.mockResolvedValueOnce({ sent: [], failed: [{ error: 'down' }] } as any);

    const result = await handleConsultingOrderPaid(null, paid, 'cs_2', { db });

    expect(result).toEqual({ ok: false, error: 'send_failed:down' });
    expect(db.docs.cs_2.paidNotifiedAt).toBeNull();
  });

  it('retries a paid notice that failed at transition time from the hourly sweep, once', async () => {
    const { handleConsultingOrderPaid, runConsultingPaidNoticeSweep } = await load();
    const now = Date.parse('2026-09-30T10:00:00Z');
    const order = { ...paid, createdAt: new Date(now - 60 * 60 * 1000) };
    const db = fakeDb({ cs_4: order });

    providersConfigured = false;
    const atTransition = await handleConsultingOrderPaid({ ...order, status: 'pending' }, order, 'cs_4', { db, nowMs: now });
    expect(atTransition).toEqual({ ok: false, error: 'no_email_provider_configured' });
    expect(db.docs.cs_4.paidNoticeStatus).toBe('failed');

    providersConfigured = true;
    const first = await runConsultingPaidNoticeSweep({ db, nowMs: now + 60 * 1000 });
    const second = await runConsultingPaidNoticeSweep({ db, nowMs: now + 2 * 60 * 1000 });
    expect(first).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(second).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sendEmailCascadeMock).toHaveBeenCalledTimes(1);
    expect((sendEmailCascadeMock.mock.calls[0][0] as any[]).map((email) => email.payload.to))
      .toEqual(['client@example.com', 'consulenza@frontaliereticino.ch']);
    expect(db.docs.cs_4.paidNoticeStatus).toBe('sent');
  });

  it('leaves consultations paid more than 72 h ago to a human', async () => {
    const { runConsultingPaidNoticeSweep } = await load();
    const now = Date.parse('2026-09-30T10:00:00Z');
    const db = fakeDb({ old: { ...paid, createdAt: new Date(now - 4 * 24 * 60 * 60 * 1000) } });
    expect(await runConsultingPaidNoticeSweep({ db, nowMs: now })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('does nothing without a paid transition or once the intake form is in', async () => {
    const { handleConsultingOrderPaid } = await load();
    const db = fakeDb({ cs_3: paid });
    expect(await handleConsultingOrderPaid(paid, paid, 'cs_3', { db })).toEqual({ ok: true, skipped: 'no_paid_transition' });
    expect(await handleConsultingOrderPaid(null, { ...paid, detailsSubmitted: true }, 'cs_3', { db }))
      .toEqual({ ok: true, skipped: 'details_already_submitted' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });
});

describe('Firestore rules — consulting_orders collection', () => {
  const root = resolve(__dirname, '..');
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');

  it('has a rules block for consulting_orders', () => {
    expect(rules).toContain('match /consulting_orders/{orderId}');
  });

  it('denies client create and list (Stripe webhook / Admin SDK only)', () => {
    const block = matchBlock(rules, 'match /consulting_orders/{orderId}');
    expect(block).toContain('allow create: if false');
    expect(block).toContain('allow list: if false');
    expect(block).toContain('allow delete: if false');
  });

  it('gates the single client update on real payment + one-time submission + frozen money fields', () => {
    const block = matchBlock(rules, 'match /consulting_orders/{orderId}');
    expect(block).toContain("resource.data.status == 'paid'");
    expect(block).toContain('resource.data.detailsSubmitted != true');
    expect(block).toContain('request.resource.data.detailsSubmitted == true');
    expect(block).toContain('request.resource.data.amountTotal == resource.data.amountTotal');
  });
});
