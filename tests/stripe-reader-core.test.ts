/**
 * tests/stripe-reader-core.test.ts
 *
 * Coverage for functions/src/stripeReaderCore.js — the reader no-ads
 * subscription domain (#3655, part 2/2 of #2961). Fully separate from the
 * publisher job-posting flow: own Firestore collection (reader_subscriptions,
 * doc id = uid), own Stripe Price (CHF 2.99/month), own webhook dispatch
 * short-circuit inside stripePublisherCore.js's handleStripeWebhook.
 *
 * Mocking strategy (mirrors tests/publisher-pending-reap.test.ts's in-memory
 * firebase-admin stub, extended with a `where(...).limit(...).get()` chain
 * for readerByStripeRef, plus a mocked `stripe` package since the checkout /
 * billing-portal happy paths actually call getStripe()):
 *   - firebase-admin: in-memory `reader_subscriptions` doc store + auth().verifyIdToken.
 *   - functions/src/remoteConfigSecrets.js: getRemoteConfigValue mock (drives
 *     both STRIPE_SECRET_KEY and STRIPE_PRICE_READER_NOADS).
 *   - stripe (npm package): mocked client — customers.create / checkout.sessions.create /
 *     billingPortal.sessions.create.
 *
 * vi.resetModules() before each test + a fresh dynamic import: stripePublisherCore.js
 * caches its Stripe client module-scope (`_stripe`), which must not leak
 * across tests with different getRemoteConfigValue mock return values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── In-memory reader_subscriptions store ────────────────────────────────
let store: Record<string, Record<string, unknown>> = {};

function makeDocRef(id: string) {
  return {
    __id: id,
    async get() {
      return {
        id,
        exists: store[id] != null,
        data: () => store[id],
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const cur = store[id] || {};
      store[id] = opts?.merge ? { ...cur, ...data } : data;
    },
  };
}

function makeCollection() {
  return {
    doc: (id: string) => makeDocRef(id),
    where: (field: string, _op: string, value: unknown) => ({
      limit: () => ({
        async get() {
          const docs = Object.entries(store)
            .filter(([, data]) => data && (data as Record<string, unknown>)[field] === value)
            .map(([id, data]) => ({ id, data: () => data, ref: makeDocRef(id) }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  };
}

const verifyIdToken = vi.fn(async (token: string) => {
  if (token === 'good-token') return { uid: 'reader1', email: 'reader1@example.com' };
  throw new Error('invalid token');
});

// ── In-memory Firebase Auth users-by-email store, for the guest checkout /
// claim-token flow (resolveOrCreateReaderUid in stripeReaderCore.js) ───────
// Fixed reference instant every mocked Stripe session's `created` defaults
// to, so per-user creationTime can be placed deterministically before/after
// it (handleClaimReaderCheckout compares the two instead of a runtime-only
// isNew flag — see stripeReaderCore.js:resolveOrCreateReaderUid).
const SESSION_CREATED_UNIX = 1_700_000_000;
let usersByEmail: Record<string, { uid: string; creationTime: string }> = {};
let uidCounter = 0;

const getUserByEmail = vi.fn(async (email: string) => {
  const rec = usersByEmail[email];
  if (!rec) {
    const err = new Error('no user') as Error & { code: string };
    err.code = 'auth/user-not-found';
    throw err;
  }
  return { uid: rec.uid, metadata: { creationTime: rec.creationTime } };
});
const createUser = vi.fn(async ({ email }: { email: string }) => {
  uidCounter += 1;
  const uid = `guest-uid-${uidCounter}`;
  // 2s after the default session's `created` — a realistic just-now creation.
  const creationTime = new Date(SESSION_CREATED_UNIX * 1000 + 2000).toISOString();
  usersByEmail[email] = { uid, creationTime };
  return { uid, metadata: { creationTime } };
});
const createCustomToken = vi.fn(async (uid: string) => `custom-token-for-${uid}`);

vi.mock('firebase-admin', () => {
  const firestore = Object.assign(() => ({ collection: () => makeCollection() }), {
    FieldValue: { serverTimestamp: () => '__ts__' },
  });
  return {
    default: {
      firestore,
      auth: () => ({ verifyIdToken, getUserByEmail, createUser, createCustomToken }),
    },
  };
});

const getRemoteConfigValueMock = vi.fn(async (key: string) => {
  if (key === 'STRIPE_SECRET_KEY') return 'sk_test_fake';
  if (key === 'STRIPE_PRICE_READER_NOADS') return 'price_reader_noads_test';
  return '';
});

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (key: string) => getRemoteConfigValueMock(key),
}));

const stripeCustomersCreate = vi.fn(async () => ({ id: 'cus_new' }));
const stripeCheckoutSessionsCreate = vi.fn(async () => ({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/cs_test_1',
}));
const stripeBillingPortalSessionsCreate = vi.fn(async () => ({
  url: 'https://billing.stripe.com/session/test',
}));
const stripeCheckoutSessionsRetrieve = vi.fn(async (): Promise<{
  id: string;
  payment_status: string;
  customer_details: { email?: string };
  metadata: { plan: string; readerUid?: string };
  created: number;
}> => ({
  id: 'cs_guest_1',
  payment_status: 'paid',
  customer_details: { email: 'guest@example.com' },
  metadata: { plan: 'reader_noads' },
  created: SESSION_CREATED_UNIX,
}));

vi.mock('stripe', () => {
  class MockStripe {
    customers = { create: stripeCustomersCreate };
    checkout = { sessions: { create: stripeCheckoutSessionsCreate, retrieve: stripeCheckoutSessionsRetrieve } };
    billingPortal = { sessions: { create: stripeBillingPortalSessionsCreate } };
  }
  return { default: MockStripe };
});

const fetchMock = vi.fn(async () => ({ ok: true }));

async function load() {
  return import('../functions/src/stripeReaderCore.js');
}

// Loose cast: the fake collection only implements the doc()/where() surface
// handleReaderWebhookEvent actually calls, not the full Firestore Admin SDK
// CollectionReference shape (id/parent/path/listDocuments/...). Casting once
// here (rather than at each of the 9 call sites) keeps every call site
// reading as plain data instead of repeating an `as any`.
function fakeCtx(ts: unknown) {
  return { db: () => ({ collection: () => makeCollection() }), ts } as unknown as {
    db: () => FirebaseFirestore.Firestore;
    ts: unknown;
  };
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    get: (h: string) => (h.toLowerCase() === 'authorization' ? 'Bearer good-token' : undefined),
    body: {},
    ...overrides,
  };
}

beforeEach(() => {
  store = {};
  usersByEmail = {};
  uidCounter = 0;
  vi.clearAllMocks();
  vi.resetModules();
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token === 'good-token') return { uid: 'reader1', email: 'reader1@example.com' };
    throw new Error('invalid token');
  });
  getUserByEmail.mockImplementation(async (email: string) => {
    const rec = usersByEmail[email];
    if (!rec) {
      const err = new Error('no user') as Error & { code: string };
      err.code = 'auth/user-not-found';
      throw err;
    }
    return { uid: rec.uid, metadata: { creationTime: rec.creationTime } };
  });
  createUser.mockImplementation(async ({ email }: { email: string }) => {
    uidCounter += 1;
    const uid = `guest-uid-${uidCounter}`;
    const creationTime = new Date(SESSION_CREATED_UNIX * 1000 + 2000).toISOString();
    usersByEmail[email] = { uid, creationTime };
    return { uid, metadata: { creationTime } };
  });
  createCustomToken.mockImplementation(async (uid: string) => `custom-token-for-${uid}`);
  getRemoteConfigValueMock.mockImplementation(async (key: string) => {
    if (key === 'STRIPE_SECRET_KEY') return 'sk_test_fake';
    if (key === 'STRIPE_PRICE_READER_NOADS') return 'price_reader_noads_test';
    return '';
  });
  stripeCheckoutSessionsRetrieve.mockImplementation(async () => ({
    id: 'cs_guest_1',
    payment_status: 'paid',
    customer_details: { email: 'guest@example.com' },
    metadata: { plan: 'reader_noads' },
    created: SESSION_CREATED_UNIX,
  }));
  fetchMock.mockImplementation(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('READER_NOADS_PLAN — drift guard vs services/readerSubscriptionPricing.ts', () => {
  it('the functions-bundle constant matches the SPA-side pricing constant', async () => {
    const { READER_NOADS_PLAN } = await load();
    const spaModule = await import('../services/readerSubscriptionPricing');
    expect(READER_NOADS_PLAN).toBe('reader_noads');
    expect(spaModule.READER_NOADS_PLAN).toBe(READER_NOADS_PLAN);
  });
});

describe('handleCreateReaderCheckout', () => {
  it('rejects non-POST', async () => {
    const { handleCreateReaderCheckout } = await load();
    const res = await handleCreateReaderCheckout(req({ method: 'GET' }));
    expect(res).toEqual({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('creates a guest checkout session when unauthenticated, no customer/uid pinned yet', async () => {
    const { handleCreateReaderCheckout, READER_NOADS_PLAN } = await load();
    const res = await handleCreateReaderCheckout(
      req({ get: () => undefined, body: { successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(res).toEqual({ status: 200, body: { ok: true, url: 'https://checkout.stripe.com/cs_test_1' } });
    expect(stripeCustomersCreate).not.toHaveBeenCalled();
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      line_items: [{ price: 'price_reader_noads_test', quantity: 1 }],
      success_url: 'https://a.test/ok?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://a.test/cancel',
      metadata: { plan: READER_NOADS_PLAN },
      subscription_data: { metadata: { plan: READER_NOADS_PLAN } },
    });
  });

  it('guest checkout appends session_id with & when successUrl already has a query string', async () => {
    const { handleCreateReaderCheckout } = await load();
    await handleCreateReaderCheckout(
      req({
        get: () => undefined,
        body: { successUrl: 'https://a.test/ok?foo=bar', cancelUrl: 'https://a.test/cancel' },
      }),
    );
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ success_url: 'https://a.test/ok?foo=bar&session_id={CHECKOUT_SESSION_ID}' }),
    );
  });

  it('guest checkout forwards posthogDistinctId into session metadata when the client sent one', async () => {
    const { handleCreateReaderCheckout, READER_NOADS_PLAN } = await load();
    await handleCreateReaderCheckout(
      req({
        get: () => undefined,
        body: {
          successUrl: 'https://a.test/ok',
          cancelUrl: 'https://a.test/cancel',
          posthogDistinctId: 'ph-anon-guest',
        },
      }),
    );
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { plan: READER_NOADS_PLAN, posthogDistinctId: 'ph-anon-guest' },
      }),
    );
  });

  it('rejects non-https(s) redirect URLs', async () => {
    const { handleCreateReaderCheckout } = await load();
    const res = await handleCreateReaderCheckout(
      req({ body: { successUrl: 'javascript:alert(1)', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_redirect_urls' } });
  });

  it('safe-fails 500 when STRIPE_PRICE_READER_NOADS is not configured yet', async () => {
    getRemoteConfigValueMock.mockImplementation(async (key: string) =>
      key === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : '',
    );
    const { handleCreateReaderCheckout } = await load();
    const res = await handleCreateReaderCheckout(
      req({ body: { successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(res).toEqual({ status: 500, body: { ok: false, error: 'reader_price_not_configured' } });
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('is a no-op for an already-active subscriber (idempotent backstop, no Stripe calls)', async () => {
    store.reader1 = { stripeCustomerId: 'cus_existing', status: 'active' };
    const { handleCreateReaderCheckout } = await load();
    const res = await handleCreateReaderCheckout(
      req({ body: { successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(res).toEqual({ status: 200, body: { ok: true, alreadyActive: true } });
    expect(stripeCustomersCreate).not.toHaveBeenCalled();
    expect(stripeCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('creates a new Stripe customer + checkout session for a first-time reader', async () => {
    const { handleCreateReaderCheckout, READER_NOADS_PLAN } = await load();
    const res = await handleCreateReaderCheckout(
      req({ body: { successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(res).toEqual({
      status: 200,
      body: { ok: true, url: 'https://checkout.stripe.com/cs_test_1' },
    });
    expect(stripeCustomersCreate).toHaveBeenCalledWith({
      email: 'reader1@example.com',
      metadata: { readerUid: 'reader1' },
    });
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_new',
        line_items: [{ price: 'price_reader_noads_test', quantity: 1 }],
        client_reference_id: 'reader1',
        metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1' },
        subscription_data: { metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1' } },
      }),
    );
    expect(store.reader1.stripeCustomerId).toBe('cus_new');
    expect(store.reader1.stripeCheckoutSessionId).toBe('cs_test_1');
  });

  it('reuses an existing (non-active) Stripe customer instead of creating a new one', async () => {
    store.reader1 = { stripeCustomerId: 'cus_existing', status: 'canceled' };
    const { handleCreateReaderCheckout } = await load();
    await handleCreateReaderCheckout(
      req({ body: { successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/cancel' } }),
    );
    expect(stripeCustomersCreate).not.toHaveBeenCalled();
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing' }),
    );
  });

  it('forwards posthogDistinctId into session metadata when the client sent one', async () => {
    const { handleCreateReaderCheckout, READER_NOADS_PLAN } = await load();
    await handleCreateReaderCheckout(
      req({
        body: {
          successUrl: 'https://a.test/ok',
          cancelUrl: 'https://a.test/cancel',
          posthogDistinctId: 'ph-anon-123',
        },
      }),
    );
    expect(stripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1', posthogDistinctId: 'ph-anon-123' },
      }),
    );
  });
});

describe('handleClaimReaderCheckout', () => {
  it('rejects non-POST', async () => {
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ method: 'GET' }));
    expect(res).toEqual({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('rejects a malformed sessionId', async () => {
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'not-a-session' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_session_id' } });
  });

  it('returns session_not_found when Stripe cannot retrieve the session', async () => {
    stripeCheckoutSessionsRetrieve.mockImplementation(async () => {
      throw new Error('No such checkout session');
    });
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_missing' } }));
    expect(res).toEqual({ status: 404, body: { ok: false, error: 'session_not_found' } });
  });

  it('rejects a session for the wrong plan', async () => {
    stripeCheckoutSessionsRetrieve.mockImplementation(async () => ({
      id: 'cs_guest_1',
      payment_status: 'paid',
      customer_details: { email: 'guest@example.com' },
      metadata: { plan: 'publisher_ad' },
      created: SESSION_CREATED_UNIX,
    }));
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'not_a_guest_session' } });
  });

  it('rejects a session that already has readerUid metadata (already-authenticated flow, nothing to claim)', async () => {
    const { handleClaimReaderCheckout, READER_NOADS_PLAN } = await load();
    stripeCheckoutSessionsRetrieve.mockImplementation(async () => ({
      id: 'cs_auth_1',
      payment_status: 'paid',
      customer_details: { email: 'reader1@example.com' },
      metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1' },
      created: SESSION_CREATED_UNIX,
    }));
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_auth_1' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'not_a_guest_session' } });
  });

  it('rejects an unpaid session', async () => {
    stripeCheckoutSessionsRetrieve.mockImplementation(async () => ({
      id: 'cs_guest_1',
      payment_status: 'unpaid',
      customer_details: { email: 'guest@example.com' },
      metadata: { plan: 'reader_noads' },
      created: SESSION_CREATED_UNIX,
    }));
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'not_paid' } });
  });

  it('rejects a paid session with no email on file', async () => {
    stripeCheckoutSessionsRetrieve.mockImplementation(async () => ({
      id: 'cs_guest_1',
      payment_status: 'paid',
      customer_details: {},
      metadata: { plan: 'reader_noads' },
      created: SESSION_CREATED_UNIX,
    }));
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'no_email_on_session' } });
  });

  it('mints a custom token for a new guest email (creates the Firebase user)', async () => {
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(getUserByEmail).toHaveBeenCalledWith('guest@example.com');
    expect(createUser).toHaveBeenCalledWith({ email: 'guest@example.com' });
    expect(createCustomToken).toHaveBeenCalledWith('guest-uid-1');
    expect(res).toEqual({ status: 200, body: { ok: true, authToken: 'custom-token-for-guest-uid-1' } });
  });

  it('refuses to mint a token when the email belongs to an account that predates this checkout session (account takeover guard)', async () => {
    // Created a full hour before this session started — genuinely pre-existing,
    // unrelated to this payment.
    usersByEmail['guest@example.com'] = {
      uid: 'existing-uid-3',
      creationTime: new Date(SESSION_CREATED_UNIX * 1000 - 3600_000).toISOString(),
    };
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(createUser).not.toHaveBeenCalled();
    expect(createCustomToken).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 409, body: { ok: false, error: 'account_exists' } });
  });

  it('mints a token even when the Stripe webhook already resolved/created the account moments before this claim call (race, not a takeover)', async () => {
    // The webhook (handleReaderWebhookEvent) can win the race against the
    // browser's redirect + claim call and create the account first. That
    // account is still a byproduct of THIS payment (created a few seconds
    // after the session started), so it must not be mistaken for a
    // pre-existing, unrelated account — see stripeReaderCore.js:L256.
    usersByEmail['guest@example.com'] = {
      uid: 'webhook-created-uid-1',
      creationTime: new Date(SESSION_CREATED_UNIX * 1000 + 3000).toISOString(),
    };
    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(createUser).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: 200,
      body: { ok: true, authToken: 'custom-token-for-webhook-created-uid-1' },
    });
  });

  it('mints a token when createUser loses a race to a concurrent create for the same brand-new email', async () => {
    const notFoundErr = new Error('no user') as Error & { code: string };
    notFoundErr.code = 'auth/user-not-found';
    const existsErr = new Error('already exists') as Error & { code: string };
    existsErr.code = 'auth/email-already-exists';
    const racedCreationTime = new Date(SESSION_CREATED_UNIX * 1000 + 1000).toISOString();

    getUserByEmail.mockImplementationOnce(async () => {
      throw notFoundErr;
    });
    createUser.mockImplementationOnce(async () => {
      throw existsErr;
    });
    getUserByEmail.mockImplementationOnce(async () => ({
      uid: 'raced-uid-1',
      metadata: { creationTime: racedCreationTime },
    }));

    const { handleClaimReaderCheckout } = await load();
    const res = await handleClaimReaderCheckout(req({ body: { sessionId: 'cs_guest_1' } }));
    expect(res).toEqual({ status: 200, body: { ok: true, authToken: 'custom-token-for-raced-uid-1' } });
  });
});

describe('handleCreateReaderBillingPortal', () => {
  it('rejects non-POST', async () => {
    const { handleCreateReaderBillingPortal } = await load();
    const res = await handleCreateReaderBillingPortal(req({ method: 'GET' }));
    expect(res).toEqual({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('rejects an unauthenticated caller', async () => {
    const { handleCreateReaderBillingPortal } = await load();
    const res = await handleCreateReaderBillingPortal(req({ get: () => undefined }));
    expect(res).toEqual({ status: 401, body: { ok: false, error: 'unauthenticated' } });
  });

  it('rejects a non-https(s) return URL', async () => {
    const { handleCreateReaderBillingPortal } = await load();
    const res = await handleCreateReaderBillingPortal(req({ body: { returnUrl: 'not-a-url' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_return_url' } });
  });

  it('returns no_customer when the reader has no Stripe customer on file', async () => {
    const { handleCreateReaderBillingPortal } = await load();
    const res = await handleCreateReaderBillingPortal(req({ body: { returnUrl: 'https://a.test/account' } }));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'no_customer' } });
  });

  it('creates a Billing Portal session for an existing customer', async () => {
    store.reader1 = { stripeCustomerId: 'cus_existing' };
    const { handleCreateReaderBillingPortal } = await load();
    const res = await handleCreateReaderBillingPortal(req({ body: { returnUrl: 'https://a.test/account' } }));
    expect(res).toEqual({ status: 200, body: { ok: true, url: 'https://billing.stripe.com/session/test' } });
    expect(stripeBillingPortalSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_existing',
      return_url: 'https://a.test/account',
    });
  });
});

describe('handleReaderWebhookEvent', () => {
  const ts = '__ts__';

  it('ignores checkout.session.completed for a different plan (falls through to publisher logic)', async () => {
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: { object: { metadata: { plan: 'publisher_ad' }, customer: 'cus_x' } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
    expect(store.reader1).toBeUndefined();
  });

  it('activates the reader subscription on checkout.session.completed for the reader_noads plan', async () => {
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          customer: 'cus_new',
          subscription: 'sub_1',
          metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1', posthogDistinctId: 'ph-anon-123' },
        },
      },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1).toEqual({
      stripeCustomerId: 'cus_new',
      stripeSubscriptionId: 'sub_1',
      stripeCheckoutSessionId: 'cs_test_1',
      status: 'active',
      updatedAt: ts,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://t.frontaliereticino.ch/capture/',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"distinct_id":"ph-anon-123"'),
      }),
    );
  });

  it('falls back to the Firebase uid as distinct_id when the client sent no posthogDistinctId', async () => {
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          customer: 'cus_new',
          subscription: 'sub_1',
          metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1' },
        },
      },
    };
    await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://t.frontaliereticino.ch/capture/',
      expect.objectContaining({ body: expect.stringContaining('"distinct_id":"reader1"') }),
    );
  });

  it('resolves/creates a Firebase uid from customer_details.email when readerUid metadata is absent (guest checkout)', async () => {
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_guest_1',
          customer: 'cus_guest',
          subscription: 'sub_guest',
          customer_details: { email: 'guest@example.com' },
          metadata: { plan: READER_NOADS_PLAN },
        },
      },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(getUserByEmail).toHaveBeenCalledWith('guest@example.com');
    expect(createUser).toHaveBeenCalledWith({ email: 'guest@example.com' });
    expect(store['guest-uid-1']).toEqual({
      stripeCustomerId: 'cus_guest',
      stripeSubscriptionId: 'sub_guest',
      stripeCheckoutSessionId: 'cs_guest_1',
      status: 'active',
      updatedAt: ts,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://t.frontaliereticino.ch/capture/',
      expect.objectContaining({ body: expect.stringContaining('"distinct_id":"guest-uid-1"') }),
    );
  });

  it('reuses the existing Firebase uid for a returning guest email instead of creating a duplicate user', async () => {
    usersByEmail['returning@example.com'] = {
      uid: 'existing-uid-7',
      creationTime: new Date(SESSION_CREATED_UNIX * 1000 - 3600_000).toISOString(),
    };
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_guest_2',
          customer: 'cus_guest2',
          subscription: 'sub_guest2',
          customer_details: { email: 'returning@example.com' },
          metadata: { plan: READER_NOADS_PLAN },
        },
      },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
    expect(store['existing-uid-7']).toBeDefined();
  });

  it('no-ops when neither readerUid metadata nor customer_details.email is present (unrecoverable)', async () => {
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_orphan_1',
          customer: 'cus_orphan',
          subscription: 'sub_orphan',
          metadata: { plan: READER_NOADS_PLAN },
        },
      },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(Object.keys(store)).toHaveLength(0);
  });

  it('does not let a PostHog capture failure break entitlement processing', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          customer: 'cus_new',
          subscription: 'sub_1',
          metadata: { plan: READER_NOADS_PLAN, readerUid: 'reader1' },
        },
      },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1).toMatchObject({ status: 'active' });
  });

  it('invoice.paid re-confirms active status for a known reader subscription', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'past_due' };
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'invoice.paid',
      data: { object: { customer: 'cus_new', subscription: 'sub_1' } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1.status).toBe('active');
  });

  it('invoice.paid falls through when no matching reader doc exists (publisher invoice)', async () => {
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'invoice.paid',
      data: { object: { customer: 'cus_publisher', subscription: 'sub_publisher' } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
  });

  it('invoice.payment_failed flips a known reader subscription to past_due', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_new', subscription: 'sub_1' } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1.status).toBe('past_due');
  });

  it('ignores customer.subscription.deleted for a different plan', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_new', metadata: { plan: 'publisher_ad' } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
    expect(store.reader1.status).toBe('active');
  });

  it('cancels a reader subscription on customer.subscription.deleted', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_new', metadata: { plan: READER_NOADS_PLAN } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1.status).toBe('canceled');
  });

  it('cancels a reader subscription on customer.subscription.canceled too', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'customer.subscription.canceled',
      data: { object: { id: 'sub_1', customer: 'cus_new', metadata: { plan: READER_NOADS_PLAN } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1.status).toBe('canceled');
  });

  it('cancels a reader subscription on customer.subscription.updated flipping straight to canceled (no separate .deleted)', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'past_due' };
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_new', status: 'canceled', metadata: { plan: READER_NOADS_PLAN } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(true);
    expect(store.reader1.status).toBe('canceled');
  });

  it.each(['unpaid', 'incomplete_expired'])(
    'cancels a reader subscription on customer.subscription.updated → %s',
    async (deadStatus) => {
      store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
      const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
      const event = {
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_new', status: deadStatus, metadata: { plan: READER_NOADS_PLAN } } },
      };
      const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
      expect(handled).toBe(true);
      expect(store.reader1.status).toBe('canceled');
    },
  );

  it('ignores customer.subscription.updated when the new status is still live (e.g. active/trialing)', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent, READER_NOADS_PLAN } = await load();
    const event = {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_new', status: 'trialing', metadata: { plan: READER_NOADS_PLAN } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
    expect(store.reader1.status).toBe('active');
  });

  it('ignores customer.subscription.updated for a different plan even with a dead status', async () => {
    store.reader1 = { stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_1', status: 'active' };
    const { handleReaderWebhookEvent } = await load();
    const event = {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_new', status: 'canceled', metadata: { plan: 'publisher_ad' } } },
    };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
    expect(store.reader1.status).toBe('active');
  });

  it('returns false for an unrelated event type (publisher domain untouched)', async () => {
    const { handleReaderWebhookEvent } = await load();
    const event = { type: 'charge.refunded', data: { object: {} } };
    const handled = await handleReaderWebhookEvent(event, fakeCtx(ts));
    expect(handled).toBe(false);
  });
});
