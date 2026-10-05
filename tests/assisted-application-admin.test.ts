import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { directRules, matchBlock } from './helpers/firestoreRulesBlock';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const firestoreRules = readFileSync(resolve(repoRoot, 'firestore.rules'), 'utf8');
const assistedOrderRules = directRules(matchBlock(firestoreRules, 'match /assisted_applications/{orderId}'));
const auditRules = directRules(matchBlock(firestoreRules, 'match /assisted_applications/{orderId}/events/{eventId}'));

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getAdminDb: vi.fn(),
  resolveCvLink: vi.fn(),
  getStripe: vi.fn(),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
}));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => mocks.getAdminDb(),
}));
vi.mock('../functions/src/publisherApplicationsCore.js', () => ({
  resolveCvLink: (...args: unknown[]) => mocks.resolveCvLink(...args),
}));
vi.mock('../functions/src/stripePublisherCore.js', () => ({
  getStripe: () => mocks.getStripe(),
}));

type Store = Record<string, Record<string, any>>;

// `meta`: the server-only documents (meta/{id}); without it the collection is unknown here, as any other.
function makeDb(initial: Record<string, any> = {}, meta: Record<string, any> | null = null) {
  const store: Store = { assisted_applications: { ...initial } };
  const events: Record<string, any[]> = {};
  let eventNumber = 0;

  function eventCollection(orderId: string) {
    return {
      doc(id?: string) {
        const eventId = id || `event-${++eventNumber}`;
        return {
          id: eventId,
          async set(data: any) {
            events[orderId] ||= [];
            events[orderId].push({ id: eventId, data });
          },
        };
      },
    };
  }

  function orderRef(id: string) {
    return {
      id,
      async get() {
        const data = store.assisted_applications[id];
        return { id, exists: data != null, data: () => data };
      },
      async set(data: any, options?: { merge?: boolean }) {
        const current = store.assisted_applications[id] || {};
        store.assisted_applications[id] = options?.merge ? { ...current, ...data } : data;
      },
      collection(name: string) {
        if (name !== 'events') throw new Error(`unexpected subcollection ${name}`);
        return eventCollection(id);
      },
    };
  }

  const applicationCollection = {
    async get() {
      return {
        docs: Object.entries(store.assisted_applications).map(([id, data]) => ({
          id,
          data: () => data,
        })),
      };
    },
    doc(id: string) {
      return orderRef(id);
    },
  };

  const db = {
    collection(name: string) {
      if (name === 'meta' && meta) {
        return { doc: (id: string) => ({ id, get: async () => ({ id, exists: meta[id] != null, data: () => meta[id] }) }) };
      }
      if (name !== 'assisted_applications') throw new Error(`unexpected collection ${name}`);
      return applicationCollection;
    },
    async runTransaction(callback: (transaction: any) => Promise<void>) {
      await callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: { merge?: boolean }) => ref.set(data, options),
      });
    },
  };

  return { db, store, events };
}

function request(overrides: Record<string, any> = {}) {
  return {
    method: 'GET',
    query: {},
    get: (header: string) => (header === 'Authorization' ? 'Bearer valid-token' : undefined),
    ...overrides,
  };
}

const ADMIN_EMAIL = 'valerielinc@gmail.com';
const signedStripe = {
  refunds: { create: vi.fn() },
  checkout: { sessions: { retrieve: vi.fn() } },
};

// eslint-disable-next-line import/first
const { handleAssistedApplicationAdmin } = await import('../functions/src/assistedApplicationAdminCore.js');

describe('assisted application admin access contract', () => {
  it('keeps direct Firestore reads/writes private and permits only the order owner or site owner read paths', () => {
    expect(assistedOrderRules).toContain('allow get: if isSiteAdmin()');
    expect(assistedOrderRules).toContain("request.auth.uid == resource.data.userId");
    expect(assistedOrderRules).toContain('allow list: if false;');
    expect(assistedOrderRules).toContain('allow create: if false;');
    expect(assistedOrderRules).toContain('allow delete: if false;');
    expect(auditRules).toContain('allow read, write: if false;');
  });

  it('rejects a non-owner admin request before reading candidate data', async () => {
    const database = makeDb();
    mocks.getAdminDb.mockReturnValue(database.db);
    mocks.verifyIdToken.mockResolvedValue({ email: 'not-owner@example.com', email_verified: true });

    const result = await handleAssistedApplicationAdmin(request());

    expect(result).toEqual({ status: 403, body: { ok: false, error: 'not_admin' } });
    expect(database.store.assisted_applications).toEqual({});
  });
});

describe('handleAssistedApplicationAdmin', () => {
  beforeEach(() => {
    mocks.verifyIdToken.mockReset();
    mocks.verifyIdToken.mockResolvedValue({ email: ADMIN_EMAIL, email_verified: true });
    mocks.resolveCvLink.mockReset();
    mocks.resolveCvLink.mockResolvedValue('https://storage.example.test/signed-cv');
    mocks.getStripe.mockReset();
    signedStripe.refunds.create.mockReset();
    signedStripe.checkout.sessions.retrieve.mockReset();
    mocks.getStripe.mockResolvedValue(signedStripe);
  });

  it('lists paid queue orders with a signed CV URL and no raw Storage path', async () => {
    const database = makeDb({
      ready: {
        jobId: 'job-1', jobUrl: 'https://jobs.example.test/job-1', companyName: 'ACME SA',
        jobTitle: 'Developer', paymentStatus: 'paid', amountTotal: 99, currency: 'eur',
        submissionStatus: 'ready_for_manual_submission', cvStorageKey: 'assisted-application-uploads/ready/cv.pdf',
        cvScanStatus: 'clean',
        consentVersion: 'assisted-application-v1', consentedAt: '2026-09-15T10:00:00.000Z',
        createdAt: '2026-09-15T10:00:00.000Z',
      },
      pending: { paymentStatus: 'pending', submissionStatus: 'awaiting_payment' },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const result = await handleAssistedApplicationAdmin(request());

    expect(result.status).toBe(200);
    expect(result.body.orders).toHaveLength(1);
    expect(result.body.orders[0]).toMatchObject({
      orderId: 'ready',
      submissionStatus: 'ready_for_manual_submission',
      hasCv: true,
      cvUrl: 'https://storage.example.test/signed-cv',
    });
    expect(result.body.orders[0].cvStorageKey).toBeUndefined();
    expect(mocks.resolveCvLink).toHaveBeenCalledWith('assisted-application-uploads/ready/cv.pdf');
  });

  it('returns the read-only order page state shown to the candidate', async () => {
    const database = makeDb({
      paid: {
        jobTitle: 'Developer', companyName: 'ACME SA', paymentStatus: 'paid',
        submissionStatus: 'awaiting_upload', cvStorageKey: 'assisted-application-uploads/paid/cv.pdf',
        consentVersion: 'assisted-application-v2', consentedAt: '2026-09-15T10:00:00.000Z',
        updatedAt: '2026-09-15T10:05:00.000Z', applicantEmail: 'candidate@example.test',
      },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const result = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'candidateView', orderId: 'paid' },
    }));

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        candidateView: {
          orderId: 'paid',
          jobTitle: 'Developer',
          companyName: 'ACME SA',
          pageState: 'paid',
          paymentStatus: 'paid',
          submissionStatus: 'awaiting_upload',
          hasCv: true,
          hasConsent: true,
          updatedAt: '2026-09-15T10:05:00.000Z',
        },
      },
    });
  });

  it('maps the queued candidate page before payment and rejects an unknown order', async () => {
    const database = makeDb({ queued: { paymentStatus: 'pending', submissionStatus: 'awaiting_payment' } });
    mocks.getAdminDb.mockReturnValue(database.db);

    const queued = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'candidateView', orderId: 'queued' },
    }));
    const missing = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'candidateView', orderId: 'missing' },
    }));

    expect(queued).toMatchObject({
      status: 200,
      body: { candidateView: { pageState: 'pending', paymentStatus: 'pending', submissionStatus: 'awaiting_payment' } },
    });
    expect(missing).toEqual({ status: 404, body: { ok: false, error: 'order_not_found' } });
  });

  it('never hides a paid order and withholds only CV links with a bad or pending verdict', async () => {
    const database = makeDb({
      clean: {
        paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
        cvStorageKey: 'assisted-application-uploads/clean/cv.pdf', cvScanStatus: 'clean',
        createdAt: '2026-09-15T10:05:00.000Z',
      },
      unscanned: {
        paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
        cvStorageKey: 'assisted-application-uploads/unscanned/cv.pdf',
        cvFileCheck: { key: 'assisted-application-uploads/unscanned/cv.pdf', verdict: 'ok', detectedType: 'pdf' },
        createdAt: '2026-09-15T10:04:00.000Z',
      },
      pending: {
        paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
        cvStorageKey: 'assisted-application-uploads/pending/cv.pdf', cvScanStatus: 'pending',
        createdAt: '2026-09-15T10:03:00.000Z',
      },
      infected: {
        paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
        cvStorageKey: 'assisted-application-uploads/infected/cv.pdf', cvScanStatus: 'infected',
        createdAt: '2026-09-15T10:02:00.000Z',
      },
      mismatch: {
        paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission',
        cvStorageKey: 'assisted-application-uploads/mismatch/cv.pdf',
        cvFileCheck: { key: 'assisted-application-uploads/mismatch/cv.pdf', verdict: 'type_mismatch', detectedType: null },
        createdAt: '2026-09-15T10:01:00.000Z',
      },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const result = await handleAssistedApplicationAdmin(request());
    const byId = Object.fromEntries(result.body.orders.map((order: any) => [order.orderId, order]));

    expect(result.status).toBe(200);
    expect(Object.keys(byId).sort()).toEqual(['clean', 'infected', 'mismatch', 'pending', 'unscanned']);
    expect(byId.clean).toMatchObject({ hasCv: true, cvUrl: 'https://storage.example.test/signed-cv', cvScanStatus: 'clean' });
    expect(byId.unscanned).toMatchObject({ hasCv: true, cvUrl: 'https://storage.example.test/signed-cv', cvScanStatus: 'unscanned', cvFileCheck: 'ok' });
    expect(byId.pending).toMatchObject({ hasCv: true, cvUrl: null, cvScanStatus: 'pending' });
    expect(byId.infected).toMatchObject({ hasCv: true, cvUrl: null, cvScanStatus: 'infected' });
    expect(byId.mismatch).toMatchObject({ hasCv: true, cvUrl: null, cvFileCheck: 'type_mismatch' });
    expect(mocks.resolveCvLink).toHaveBeenCalledTimes(2);
  });

  // The self-check of the PDF renderer (functions/src/assistedApplicationRendererCheck.js), read and never run here.
  it('returns the last self-check of the PDF renderer next to the orders', async () => {
    const check = {
      status: 'failed', switch: 'typst', error: 'assisted-letter.typ: 0: file not found', node: 'v22.0.0',
      service: 'sweepassistedapplicationfollowups', revision: 'sweepassistedapplicationfollowups-00042-abc', rssMb: 180, checkedAt: 2_000, failingSince: 1_000,
    };
    const order = { ready: { paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', createdAt: '2026-09-15T10:00:00.000Z' } };

    mocks.getAdminDb.mockReturnValue(makeDb(order, { assistedApplicationPdfRenderer: check }).db);
    const stored = await handleAssistedApplicationAdmin(request());
    mocks.getAdminDb.mockReturnValue(makeDb(order, {}).db);
    const never = await handleAssistedApplicationAdmin(request());

    expect(stored.body).toMatchObject({ ok: true, pdfRenderer: check, orders: [expect.objectContaining({ orderId: 'ready' })] });
    // Before the first check.
    expect(never.body).toMatchObject({ ok: true, pdfRenderer: null });
  });

  it('lists the queue when the self-check cannot be read', async () => {
    // No `meta` here: the fake database throws on it, as a failing read would.
    mocks.getAdminDb.mockReturnValue(makeDb({
      ready: { paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', createdAt: '2026-09-15T10:00:00.000Z' },
    }).db);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleAssistedApplicationAdmin(request());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, pdfRenderer: null, orders: [expect.objectContaining({ orderId: 'ready' })] });
    expect(logged).toHaveBeenCalledWith('[manageAssistedApplicationAdmin] renderer check not read', 'unexpected collection meta');
    logged.mockRestore();
  });

  it('lists paid orders still waiting for materials with the checkout email and email status', async () => {
    const database = makeDb({
      waiting: {
        paymentStatus: 'paid', submissionStatus: 'awaiting_upload', customerEmail: 'buyer@example.com', locale: 'fr',
        notifications: { customer_intro: { status: 'sent' } },
        createdAt: '2026-09-24T09:21:59.000Z',
      },
      unpaid: { paymentStatus: 'pending', submissionStatus: 'awaiting_payment' },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const all = await handleAssistedApplicationAdmin(request());
    const filtered = await handleAssistedApplicationAdmin(request({ query: { status: 'awaiting_upload' } }));

    expect(all.body.orders.map((order: any) => order.orderId)).toEqual(['waiting']);
    expect(all.body.orders[0]).toMatchObject({
      submissionStatus: 'awaiting_upload',
      customerEmail: 'buyer@example.com',
      locale: 'fr',
      hasCv: false,
      cvScanStatus: null,
      emails: { intro: 'sent', reminder: null, submitted: null },
    });
    expect(filtered.body.orders.map((order: any) => order.orderId)).toEqual(['waiting']);
  });

  it('records materials received by email as awaiting_upload → in_progress', async () => {
    const database = makeDb({
      waiting: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload' },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const result = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'transitionStatus', orderId: 'waiting', submissionStatus: 'in_progress', submissionNotes: 'CV ricevuto via email.' },
    }));

    expect(result).toEqual({ status: 200, body: { ok: true, orderId: 'waiting', submissionStatus: 'in_progress' } });
    expect(database.events.waiting[0].data).toMatchObject({
      eventType: 'materials_received_by_email',
      fromStatus: 'awaiting_upload',
      toStatus: 'in_progress',
    });
  });

  it('records a completed transition and rejects submitted → awaiting_upload', async () => {
    const database = makeDb({
      ready: { paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', createdAt: '2026-09-15T10:00:00.000Z' },
      submitted: { paymentStatus: 'paid', submissionStatus: 'submitted' },
    });
    mocks.getAdminDb.mockReturnValue(database.db);

    const completed = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'transitionStatus', orderId: 'ready', submissionStatus: 'submitted', submissionNotes: 'Inviata tramite portale aziendale.' },
    }));
    const invalid = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'transitionStatus', orderId: 'submitted', submissionStatus: 'awaiting_upload' },
    }));

    expect(completed).toEqual({ status: 200, body: { ok: true, orderId: 'ready', submissionStatus: 'submitted' } });
    expect(database.store.assisted_applications.ready).toMatchObject({
      submissionStatus: 'submitted',
      submissionNotes: 'Inviata tramite portale aziendale.',
    });
    expect(database.events.ready[0].data).toMatchObject({
      eventType: 'manual_submission_completed',
      fromStatus: 'ready_for_manual_submission',
      toStatus: 'submitted',
    });
    expect(invalid).toEqual({ status: 409, body: { ok: false, error: 'invalid_transition' } });
    expect(database.store.assisted_applications.submitted.submissionStatus).toBe('submitted');
  });

  it('requires a block reason and issues an audited full Stripe refund', async () => {
    const database = makeDb({
      blocked: {
        paymentStatus: 'paid', submissionStatus: 'in_progress', stripePaymentIntentId: 'pi_assisted_1',
      },
    });
    mocks.getAdminDb.mockReturnValue(database.db);
    signedStripe.refunds.create.mockResolvedValue({ id: 're_assisted_1', status: 'succeeded' });

    const missingReason = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'transitionStatus', orderId: 'blocked', submissionStatus: 'blocked' },
    }));
    const refunded = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'refund', orderId: 'blocked', submissionNotes: 'Processo aziendale non delegabile.' },
    }));

    expect(missingReason).toEqual({ status: 400, body: { ok: false, error: 'blocked_reason_required' } });
    expect(signedStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_assisted_1' },
      { idempotencyKey: 'assisted-application-refund:blocked' },
    );
    expect(refunded).toMatchObject({ status: 200, body: { ok: true, orderId: 'blocked', submissionStatus: 'refunded', refundId: 're_assisted_1' } });
    expect(database.store.assisted_applications.blocked).toMatchObject({ paymentStatus: 'refunded', submissionStatus: 'refunded' });
    expect(database.events.blocked[0].data).toMatchObject({ eventType: 'refund_issued', refundId: 're_assisted_1' });
  });

  it('does not mark an order refunded when Stripe returns a pending refund', async () => {
    const database = makeDb({
      blocked: {
        paymentStatus: 'paid', submissionStatus: 'in_progress', stripePaymentIntentId: 'pi_assisted_pending',
      },
    });
    mocks.getAdminDb.mockReturnValue(database.db);
    signedStripe.refunds.create.mockResolvedValue({ id: 're_assisted_pending', status: 'pending' });

    const result = await handleAssistedApplicationAdmin(request({
      method: 'POST',
      body: { action: 'refund', orderId: 'blocked' },
    }));

    expect(result).toEqual({ status: 502, body: { ok: false, error: 'stripe_refund_failed' } });
    expect(database.store.assisted_applications.blocked).toMatchObject({
      paymentStatus: 'paid',
      submissionStatus: 'in_progress',
      refundStatus: null,
      refundReservationId: null,
      refundPendingAt: null,
    });
    expect(database.store.assisted_applications.blocked).not.toHaveProperty('stripeRefundId');
    expect(database.events.blocked || []).toHaveLength(0);
  });
});
