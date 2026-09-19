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

function makeDb(initial: Record<string, any> = {}) {
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
