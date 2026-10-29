import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const files = new Set<string>();
  let childSequence = 0;
  let copyHook: (() => void) | null = null;

  function pathKey(path: string) {
    return path.replace(/^\/+|\/+$/g, '');
  }

  function mergeData(path: string, data: Record<string, unknown>, merge = false) {
    const normalized = pathKey(path);
    const current = documents.get(normalized) || {};
    const next = merge ? { ...current } : {};
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && (value as any).__increment !== undefined) {
        next[field] = Number(next[field] || 0) + Number((value as any).__increment);
      } else {
        next[field] = value;
      }
    }
    documents.set(normalized, next);
  }

  function makeDocRef(path: string) {
    const normalized = pathKey(path);
    const parts = normalized.split('/');
    return {
      id: parts[parts.length - 1],
      data: () => documents.get(normalized),
      async get() {
        const data = documents.get(normalized);
        return { id: parts[parts.length - 1], exists: Boolean(data), data: () => data };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        mergeData(normalized, data, options?.merge === true);
      },
      collection(name: string) {
        return makeCollection(normalized + '/' + name);
      },
    };
  }

  function makeCollection(path: string) {
    const normalized = pathKey(path);
    return {
      doc(id?: string) {
        const value = id || 'child-' + (++childSequence);
        return makeDocRef(normalized + '/' + value);
      },
      async get() {
        const prefix = normalized + '/';
        const docs = [...documents.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map(([key, data]) => makeDocRef(key));
        return { docs };
      },
    };
  }

  const firestore = {
    collection: (name: string) => makeCollection(name),
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => ref.set(data, options),
      });
    },
    batch() {
      const operations: Array<() => void> = [];
      return {
        set(ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) {
          operations.push(() => ref.set(data, options));
        },
        async commit() {
          operations.forEach((operation) => operation());
        },
      };
    },
  };

  const bucket = {
    file(path: string) {
      return {
        path,
        async exists() {
          return [files.has(path)];
        },
        async getMetadata() {
          return [{ size: 100, contentType: 'application/pdf' }];
        },
        async copy(target: { path: string }) {
          files.add(target.path);
          copyHook?.();
        },
        async delete() {
          files.delete(path);
        },
      };
    },
  };

  return {
    createCustomToken: vi.fn(async () => 'owner-token'),
    getUser: vi.fn(async (uid: string) => ({ uid })),
    documents,
    files,
    setCopyHook(hook: (() => void) | null) { copyHook = hook; },
    firestore,
    bucket,
    getAdminDb: vi.fn(() => firestore),
    getStorage: vi.fn(() => ({ bucket: () => bucket })),
    verifyCaller: vi.fn(async () => ({ uid: 'candidate-42' })),
    assertSiteAdmin: vi.fn(async () => ({ ok: true, email: 'owner@example.test' })),
    reset() {
      documents.clear();
      files.clear();
      childSequence = 0;
      copyHook = null;
    },
  };
});

vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ createCustomToken: mocks.createCustomToken, getUser: mocks.getUser }) }));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: {
    now: () => new Date(),
  },
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: mocks.getStorage,
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: mocks.getAdminDb,
}));

vi.mock('../functions/src/adminAuth.js', () => ({
  assertSiteAdmin: mocks.assertSiteAdmin,
}));

vi.mock('../functions/src/stripePublisherCore.js', () => ({
  verifyCaller: mocks.verifyCaller,
}));

vi.mock('../functions/src/assistedApplicationCheckout.js', () => ({
  ASSISTED_APPLICATION_CONSENT_VERSION: 'assisted-application-v1',
}));



vi.mock('../functions/src/assistedApplicationCvCheck.js', () => ({
  ASSISTED_APPLICATION_STORAGE_BUCKET: 'test-bucket',
}));

vi.mock('../functions/src/applicationConciergeEligibility.js', () => ({ prepareConciergeEligibility: vi.fn() }));
vi.mock('../functions/src/assistedApplicationReviewToken.js', async (original) => ({ ...await original<typeof import('../functions/src/assistedApplicationReviewToken.js')>(), getReviewTokenSecret: vi.fn(async () => 'test-review-secret-for-candidate-access-123456') }));
const { handleApplicationConcierge, handleManageApplicationConcierge } = await import('../functions/src/applicationConciergeCore.js');

function seedService() {
  mocks.documents.set('application_concierge_services/service-1', {
    userId: 'candidate-42',
    paymentStatus: 'paid',
    serviceStatus: 'active',
    renewal: false,
    maxPositions: 10,
    acceptedPositionsCount: 0,
    currency: 'eur',
    customerEmail: 'candidate@example.test',
    applicantName: 'Candidate Example',
    applicantEmail: 'candidate@example.test',
    consentVersion: 'application-concierge-v1',
    consentedAt: new Date(),
    cvStorageKey: 'application-concierge-uploads/service-1/cv.pdf',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  mocks.documents.set('application_concierge_services/service-1/proposals/proposal-1', {
    jobId: 'job-1',
    jobUrl: 'https://jobs.example.test/job-1',
    companyId: 'company-1',
    companyName: 'Example SA',
    jobTitle: 'Software Developer',
    location: 'Lugano',
    applyMode: 'portal',
    status: 'proposed',
    eligibilityStatus: 'compatible',
    eligibilityCvStorageKey: 'application-concierge-uploads/service-1/cv.pdf',
  });
  mocks.files.add('application-concierge-uploads/service-1/cv.pdf');
}

beforeEach(() => {
  mocks.reset();
  seedService();
});

describe('historic concierge payment link session recovery', () => {
  it('refuses a revoked caller before minting a replacement session, including normalized actions', async () => {
    mocks.verifyCaller.mockResolvedValueOnce(null as any);
    mocks.createCustomToken.mockClear();
    const req = { method: 'POST', body: { action: ' recoverPaymentSession ', serviceId: 'service-1' } };
    const result = await handleApplicationConcierge(req);
    expect(mocks.verifyCaller).toHaveBeenCalledWith(req, { checkRevoked: true });
    expect(result).toMatchObject({ status: 401, body: { ok: false, error: 'unauthenticated' } });
    expect(mocks.createCustomToken).not.toHaveBeenCalled();
  });

  it.each([
    { email_verified: false, email: 'candidate@example.test', allowed: false },
    { email_verified: true, email: 'other@example.test', allowed: false },
    { email_verified: true, email: 'candidate@example.test', allowed: true },
  ])('requires verified recipient email: %j', async ({ allowed, ...claims }) => {
    mocks.documents.set('application_concierge_services/service-recover', {
      userId: 'anonymous-owner', customerEmail: 'candidate@example.test',
      paymentStatus: 'pending', serviceStatus: 'awaiting_payment',
    });
    mocks.verifyCaller.mockResolvedValueOnce({ uid: 'signed-in-user', ...claims } as any);
    const result = await handleApplicationConcierge({ method: 'POST', body: {
      action: 'recoverPaymentSession', serviceId: 'service-recover',
    } });
    expect(result.status).toBe(allowed ? 200 : 404);
    if (allowed) {
      expect(result.body.authToken).toBe('owner-token');
      expect(mocks.createCustomToken).toHaveBeenCalledWith('anonymous-owner');
    } else expect(result.body.authToken).toBeUndefined();
  });
});

describe('verified concierge recipient cannot impersonate registered owner', () => {
  it.each([{ email: 'owner@example.test' }, { disabled: true }])('rejects unsafe owner: %j', async (owner) => {
    mocks.documents.set('application_concierge_services/service-recover', {
      userId: 'registered-owner', customerEmail: 'candidate@example.test',
      paymentStatus: 'pending', serviceStatus: 'awaiting_payment',
    });
    mocks.verifyCaller.mockResolvedValueOnce({ uid: 'recipient', email: 'candidate@example.test', email_verified: true } as any);
    mocks.getUser.mockResolvedValueOnce({ uid: 'registered-owner', ...owner } as any);
    const result = await handleApplicationConcierge({ method: 'POST', body: {
      action: 'recoverPaymentSession', serviceId: 'service-recover',
    } });
    expect(result.status).toBe(404);
    expect(result.body.authToken).toBeUndefined();
  });
});

describe('application concierge candidate API', () => {
  it('exposes incomplete verification separately from an empty matching result', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), matchingStatus: 'complete', matchingJobCount: 0,
      matchingUnverifiedCount: 7, matchingClarificationCount: 3 });
    const result = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(result).toMatchObject({ status: 200, body: { service: { matchingJobCount: 0,
      matchingUnverifiedCount: 7, matchingClarificationCount: 3 } } });
  });

  it('returns checkout session state used by candidate payment recovery guards', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), paymentStatus: 'pending', checkoutSessionStatus: 'open' });
    const result = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(result).toMatchObject({ status: 200, body: { ok: true, service: {
      paymentStatus: 'pending', checkoutSessionStatus: 'open',
    } } });
  });

  it('serializes actual failed SumUp state consumed by the retry UI', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), paymentProvider: 'sumup', paymentStatus: 'failed',
      serviceStatus: 'payment_failed', checkoutSessionStatus: 'failed' });
    const result = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(result).toMatchObject({ status: 200, body: { ok: true, service: {
      paymentProvider: 'sumup', paymentStatus: 'failed', serviceStatus: 'payment_failed', checkoutSessionStatus: 'failed',
    } } });
  });

  it('creates a child assisted application only after explicit proposal acceptance', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'acceptProposal',
        proposalId: 'proposal-1',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).childApplicationId).toBe('child-1');
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      acceptedPositionsCount: 1,
    }));
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toEqual(expect.objectContaining({
      status: 'accepted',
      childApplicationId: 'child-1',
    }));
    expect(mocks.documents.get('assisted_applications/child-1')).toEqual(expect.objectContaining({
      billingMode: 'application_concierge',
      parentServiceId: 'service-1',
      parentProposalId: 'proposal-1',
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      jobId: 'job-1',
    }));
    expect([...mocks.files].some((path) => path.startsWith('assisted-application-uploads/child-1/'))).toBe(true);
  });

  it('rejects a compatible verdict tied to an older CV before copying it', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.cvStorageKey = 'application-concierge-uploads/service-1/new-cv.pdf';
    mocks.files.add(service.cvStorageKey as string);

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect([...mocks.files].some(path => path.startsWith('assisted-application-uploads/'))).toBe(false);
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('rejects an acceptance when the service CV changes while the proposal CV is being copied', async () => {
    mocks.setCopyHook(() => {
      mocks.documents.get('application_concierge_services/service-1')!.cvStorageKey = 'application-concierge-uploads/service-1/new-cv.pdf';
    });

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect([...mocks.files].some(path => path.startsWith('assisted-application-uploads/'))).toBe(false);
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('does not create a child application for a declined proposal', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'declineProposal',
        proposalId: 'proposal-1',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toEqual(expect.objectContaining({
      status: 'declined',
    }));
    expect([...mocks.documents.keys()].some((path) => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('requires explicit consent even when the caller supplies the contract version', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.consentVersion = null;

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consentVersion: 'application-concierge-v1',
        consent: false,
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: 'consent_required' },
    });
  });

  it('saves editable candidate details without rewriting an existing consent', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Updated',
        applicantEmail: 'updated@example.test',
        applicantPhone: '+41 79 000 00 00',
        applicantLocation: 'Mendrisio 6850',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      applicantName: 'Candidate Updated',
      applicantEmail: 'updated@example.test',
      applicantLocation: 'Mendrisio 6850',
      matchingStatus: 'queued',
      consentVersion: 'application-concierge-v1',
    }));
    expect((result.body as any).service.applicantLocation).toBe('Mendrisio 6850');
  });

  it('orders proposals by their capped match score plus private proximity weight', async () => {
    mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!.matchScore = 50;
    mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!.matchRankingScore = 58;
    mocks.documents.set('application_concierge_services/service-1/proposals/proposal-2', {
      jobId: 'job-2',
      jobUrl: 'https://jobs.example.test/job-2',
      companyId: 'company-2',
      companyName: 'Nearby SA',
      jobTitle: 'Developer',
      status: 'proposed',
    eligibilityStatus: 'compatible',
      matchScore: 53,
      matchRankingScore: 53,
    });

    const result = await handleApplicationConcierge({
      method: 'GET',
      query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token',
    });

    expect((result.body as any).service.proposals.map((proposal: any) => proposal.proposalId)).toEqual(['proposal-1', 'proposal-2']);
    expect((result.body as any).service.proposals[0].matchScore).toBe(50);
  });

  it('records concierge consent as a separate idempotent action', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.consentVersion = null;
    service.consentedAt = null;

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'recordConsent',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consent: true,
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).service.hasConsent).toBe(true);
    const firstConsent = mocks.documents.get('application_concierge_services/service-1')!.consentedAt;

    const second = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'recordConsent',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consent: true,
      },
      get: () => 'Bearer candidate-token',
    });
    expect(second.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')!.consentedAt).toBe(firstConsent);
  });

  it('lists the candidate-owned services when no service id is supplied', async () => {
    const result = await handleApplicationConcierge({
      method: 'GET',
      query: {},
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).services).toHaveLength(1);
    expect((result.body as any).services[0].serviceId).toBe('service-1');
  });
});


it('blocks accepting an unverified legacy proposal while still allowing the candidate to decline it', async () => {
  seedService();
  const proposal = mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!;
  delete proposal.eligibilityStatus;
  const base = { serviceId: 'service-1', proposalId: 'proposal-1' };
  const accepted = await handleApplicationConcierge({ method: 'POST', body: { ...base, action: 'acceptProposal' }, get: () => 'Bearer candidate-token' });
  expect(accepted).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
  expect([...mocks.documents.keys()].filter(path => path.startsWith('assisted_applications/'))).toHaveLength(0);
  const declined = await handleApplicationConcierge({ method: 'POST', body: { ...base, action: 'declineProposal' }, get: () => 'Bearer candidate-token' });
  expect(declined.status).toBe(200);
});

describe('owned child status and private review access from the service', () => {
  function acceptedChild(patch: Record<string, unknown> = {}) {
    const proposal = mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!;
    Object.assign(proposal, { status: 'accepted', childApplicationId: 'child-accepted-1' });
    mocks.documents.set('assisted_applications/child-accepted-1', {
      userId: 'candidate-42', paymentStatus: 'paid', parentServiceId: 'service-1', parentProposalId: 'proposal-1',
      automationState: 'needs_candidate_action', submissionStatus: 'awaiting_upload', ...patch,
    });
    mocks.documents.set('assisted_applications/child-accepted-1/automation/flow', { state: 'needs_candidate_action', round: 2 });
  }
  const open = () => handleApplicationConcierge({ method: 'POST', body: { action: 'openChildReview', serviceId: 'service-1', proposalId: 'proposal-1' }, get: () => 'Bearer candidate-token' });
  it('shows the child state and mints access for the current round after an owner check', async () => {
    acceptedChild();
    const status = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(status.body.service.proposals[0]).toMatchObject({ childApplicationState: 'needs_candidate_action', childSubmissionStatus: 'awaiting_upload' });
    const access = await open();
    expect(access.status).toBe(200);
    const { verifyReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
    expect(verifyReviewToken({ secret: 'test-review-secret-for-candidate-access-123456', token: access.body.token })).toMatchObject({ ok: true, orderId: 'child-accepted-1', round: 2 });
    expect(mocks.verifyCaller).toHaveBeenLastCalledWith(expect.anything(), { checkRevoked: true });
  });
  it('uses the same owned child status in candidate and admin summaries', async () => {
    acceptedChild();
    const candidate = await handleApplicationConcierge({ method: 'GET', query: {} });
    const admin = await handleManageApplicationConcierge({ method: 'GET' });
    for (const result of [candidate, admin]) expect(result).toMatchObject({ status: 200, body: {
      services: [expect.objectContaining({ proposals: [expect.objectContaining({
        childApplicationState: 'needs_candidate_action', childCandidateStatus: 'needs_candidate',
      })] })],
    } });
  });
  it.each([{ userId: 'different-candidate' }, { parentServiceId: 'different-service' }, { retentionPurgedAt: new Date() }])('does not expose a child outside the owned service or after purge: %j', async patch => {
    acceptedChild(patch);
    expect(await open()).toMatchObject({ status: 404, body: { error: 'proposal_not_found' } });
  });
  it('allows an owned accepted application to be completed after the proposal window expires', async () => {
    acceptedChild();
    const parent = mocks.documents.get('application_concierge_services/service-1')!;
    Object.assign(parent, { serviceStatus: 'expired', expiresAt: new Date(Date.now() - 86400000) });
    expect((await open()).status).toBe(200);
  });
});
