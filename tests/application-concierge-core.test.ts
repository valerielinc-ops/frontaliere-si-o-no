import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const files = new Set<string>();
  const fileMetadata = new Map<string, Record<string, unknown>>();
  let storageGeneration = 0;
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
        return { id: parts[parts.length - 1], ref: makeDocRef(normalized), exists: Boolean(data), data: () => data };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        mergeData(normalized, data, options?.merge === true);
      },
      async delete() { documents.delete(normalized); },
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
        delete: (ref: any) => ref.delete(),
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
          if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 404 });
          return [fileMetadata.get(path) || { size: 100, contentType: 'application/pdf', generation: '1', metadata: {} }];
        },
        async download() {
          if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 404 });
          return [Buffer.alloc(Number(fileMetadata.get(path)?.size) || 100)];
        },
        async save(buffer: Buffer, options: any = {}) {
          if (files.has(path)) throw Object.assign(new Error('precondition failed'), { code: 412 });
          files.add(path);
          fileMetadata.set(path, { size: buffer.length, contentType: options.contentType || 'application/pdf',
            generation: String(++storageGeneration), metadata: options.metadata?.metadata || {} });
          copyHook?.();
        },
        async copy(target: { path: string }) {
          files.add(target.path);
          copyHook?.();
        },
        async delete() {
          files.delete(path);
          fileMetadata.delete(path);
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
      fileMetadata.clear();
      storageGeneration = 0;
      childSequence = 0;
      copyHook = null;
    },
  };
});

const renewalRollout = vi.hoisted(() => ({ isEnabledFor: vi.fn(async () => false) }));

vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ createCustomToken: mocks.createCustomToken, getUser: mocks.getUser }) }));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: {
    now: () => new Date(),
    fromMillis: (value: number) => new Date(value),
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

vi.mock('../functions/src/applicationConciergeRenewalRollout.js', () => ({
  isApplicationConciergeRenewalEnabledFor: renewalRollout.isEnabledFor,
}));



vi.mock('../functions/src/assistedApplicationCvCheck.js', () => ({
  ASSISTED_APPLICATION_STORAGE_BUCKET: 'test-bucket',
}));

vi.mock('../functions/src/applicationConciergeEligibility.js', () => ({
  CONCIERGE_ELIGIBILITY_VERSION: 'full-posting-requirements-v4-source-citations-v1',
  CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID: 'candidate-language-facts',
  candidateAnswersDocumentId: (cacheId: string) => `candidate-answers-${String(cacheId || '').slice(0, 60)}`,
  eligibilityHash: (value: string) => String(value).length.toString(16),
  prepareConciergeEligibility: vi.fn(),
}));
vi.mock('../functions/src/assistedApplicationReviewToken.js', async (original) => ({ ...await original<typeof import('../functions/src/assistedApplicationReviewToken.js')>(), getReviewTokenSecret: vi.fn(async () => 'test-review-secret-for-candidate-access-123456') }));
const { handleApplicationConcierge, handleManageApplicationConcierge } = await import('../functions/src/applicationConciergeCore.js');
const { CONCIERGE_ELIGIBILITY_VERSION, prepareConciergeEligibility } = await import('../functions/src/applicationConciergeEligibility.js');

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
    eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
    eligibilityCvStorageKey: 'application-concierge-uploads/service-1/cv.pdf',
  });
  mocks.files.add('application-concierge-uploads/service-1/cv.pdf');
}

beforeEach(() => {
  mocks.reset();
  renewalRollout.isEnabledFor.mockResolvedValue(false);
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
  it('does not read the renewal rollout for a service without an available offer', async () => {
    await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(renewalRollout.isEnabledFor).not.toHaveBeenCalled();
  });

  it('reports no remaining positions when a legacy service stores a limit above the product cap', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), maxPositions: 20, acceptedPositionsCount: 10 });

    const result = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });

    expect(result).toMatchObject({ status: 200, body: { service: {
      maxPositions: 10, acceptedPositionsCount: 10, remainingPositions: 0,
    } } });
  });

  it('shows renewal offers only to candidates in the configured rollout', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.serviceStatus = 'expired';
    service.expiresAt = new Date(Date.now() - 1);
    renewalRollout.isEnabledFor.mockResolvedValue(true);
    const enabled = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(enabled.body.service.renewalOffer).toMatchObject({ amountTotal: 2999 });

    renewalRollout.isEnabledFor.mockResolvedValue(false);
    const disabled = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(disabled.body.service.renewalOffer).toBeNull();
  });

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
      locale: 'it',
      jobId: 'job-1',
    }));
    expect([...mocks.files].some((path) => path.startsWith('assisted-application-uploads/child-1/'))).toBe(true);
  });

  it('blocks candidate acceptance at the product cap even when a legacy service stores a larger limit', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), maxPositions: 20, acceptedPositionsCount: 10 });

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toMatchObject({ status: 409, body: { ok: false, error: 'position_limit_reached' } });
    expect(mocks.documents.get(key)).toMatchObject({ maxPositions: 20, acceptedPositionsCount: 10 });
    expect(mocks.documents.get(`${key}/proposals/proposal-1`)).toMatchObject({ status: 'proposed' });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('reports the position limit when another acceptance fills the last slot during CV copy', async () => {
    const key = 'application_concierge_services/service-1';
    mocks.documents.set(key, { ...mocks.documents.get(key), maxPositions: 20, acceptedPositionsCount: 9 });
    mocks.setCopyHook(() => {
      mocks.documents.set(key, { ...mocks.documents.get(key), acceptedPositionsCount: 10 });
    });

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toMatchObject({ status: 409, body: { ok: false, error: 'position_limit_reached' } });
    expect(mocks.documents.get(key)).toMatchObject({ acceptedPositionsCount: 10 });
    expect(mocks.documents.get(`${key}/proposals/proposal-1`)).toMatchObject({ status: 'proposed' });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
    expect([...mocks.files].some(path => path.startsWith('assisted-application-uploads/'))).toBe(false);
  });

  it('keeps the existing cv_not_found API error when the source disappears before copying', async () => {
    mocks.files.delete('application-concierge-uploads/service-1/cv.pdf');

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toMatchObject({ status: 409, body: { ok: false, error: 'cv_not_found' } });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('reuses the accepted child when the acceptance response is retried after an ACK loss', async () => {
    const request = {
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    };
    const first = await handleApplicationConcierge(request);
    const childId = (first.body as any).childApplicationId;
    const child = mocks.documents.get(`assisted_applications/${childId}`)!;
    const childKey = child.cvStorageKey;
    const filesAfterFirst = [...mocks.files].sort();

    const retry = await handleApplicationConcierge(request);

    expect(retry).toMatchObject({ status: 200, body: { childApplicationId: childId } });
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({ acceptedPositionsCount: 1 }));
    expect(mocks.documents.get(`assisted_applications/${childId}`)).toEqual(expect.objectContaining({ cvStorageKey: childKey }));
    expect([...mocks.files].sort()).toEqual(filesAfterFirst);
    expect([...mocks.documents.keys()].filter(path => path.startsWith('assisted_applications/'))).toEqual([`assisted_applications/${childId}`]);
  });

  it('copies the current validated service locale into the accepted child inside the transaction', async () => {
    mocks.documents.get('application_concierge_services/service-1')!.locale = 'de';
    mocks.setCopyHook(() => {
      const storedService = mocks.documents.get('application_concierge_services/service-1')!;
      mocks.documents.set('application_concierge_services/service-1', { ...storedService, locale: 'fr' });
    });

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('assisted_applications/child-1')).toEqual(expect.objectContaining({ locale: 'fr' }));
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

  it('marks a legacy compatible proposal for re-verification and blocks acceptance until a current match run', async () => {
    const proposal = mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!;
    proposal.eligibilityVersion = 'full-posting-requirements-v3-source-citations-v1';

    const listed = await handleApplicationConcierge({
      method: 'GET',
      query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token',
    });
    expect((listed.body as any).service.proposals[0]).toMatchObject({ status: 'proposed', eligibilityStatus: 'needs_verification' });

    const accepted = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });
    expect(accepted).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect([...mocks.files].some(path => path.startsWith('assisted-application-uploads/'))).toBe(false);
  });

  it('blocks a legacy proposal with no stored eligibility evidence before creating its child order', async () => {
    const proposal = mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!;
    delete proposal.eligibilityStatus;
    delete proposal.eligibilityVersion;
    delete proposal.eligibilityCvStorageKey;

    const listed = await handleApplicationConcierge({
      method: 'GET',
      query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token',
    });
    expect((listed.body as any).service.proposals[0]).toMatchObject({ status: 'proposed', eligibilityStatus: 'needs_verification' });

    const accepted = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });

    expect(accepted).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toMatchObject({ status: 'proposed' });
    expect([...mocks.files].some(path => path.startsWith('assisted-application-uploads/'))).toBe(false);
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it.each(['queued', 'running', 'failed', 'needs_review'])('keeps a proposal visible but blocks acceptance while matching is %s', async (matchingStatus) => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.matchingStatus = matchingStatus;

    const listed = await handleApplicationConcierge({
      method: 'GET',
      query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token',
    });
    expect((listed.body as any).service.proposals[0]).toMatchObject({
      status: 'proposed', eligibilityStatus: 'needs_verification',
    });

    const accepted = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1' },
      get: () => 'Bearer candidate-token',
    });
    expect(accepted).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toMatchObject({ status: 'proposed' });
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

  it('blocks acceptance when candidate facts changed after the last eligibility check', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    const proposal = mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')!;
    service.eligibilityFactsRevision = 1;
    service.matchingStatus = 'complete';
    proposal.eligibilityFactsRevision = 0;

    const listed = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token' });
    const accepted = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', action: 'acceptProposal', proposalId: 'proposal-1',
    }, get: () => 'Bearer candidate-token' });

    expect((listed.body as any).service.proposals[0]).toMatchObject({ status: 'proposed', eligibilityStatus: 'needs_verification' });
    expect(accepted).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
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

  it('stores candidate-confirmed language facts in the service retention scope and queues a new check', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: { serviceId: 'service-1', action: 'saveCandidateLanguageFacts', listComplete: true,
        languages: [{ languageCode: 'it', level: 'native' }, { languageCode: 'de', level: 'unknown' }] },
      get: () => 'Bearer candidate-token',
    });
    const facts = mocks.documents.get('application_concierge_services/service-1/eligibility/candidate-language-facts');

    expect(result.status).toBe(200);
    expect(facts).toMatchObject({
      provenance: 'candidate_confirmed',
      schemaVersion: 'application-concierge-candidate-languages-v1',
      listComplete: true,
      languages: [{ languageCode: 'de', level: 'unknown' }, { languageCode: 'it', level: 'native' }],
    });
    expect(facts?.confirmedAt).toBeInstanceOf(Date);
    expect(result.body.service.candidateLanguageFacts).toMatchObject({ listComplete: true, languages: facts?.languages });
    expect(mocks.documents.get('application_concierge_services/service-1')).toMatchObject({
      eligibilityFactsRevision: 1, matchingStatus: 'queued',
    });
    expect(mocks.documents.get('application_concierge_services/service-1/eligibility/candidate-answers')).toBeUndefined();
  });

  it('records proposal interest and typed answers without starting a child until a fresh compatible check and acceptance', async () => {
    const servicePath = 'application_concierge_services/service-1';
    const proposalPath = `${servicePath}/proposals/proposal-1`;
    const cacheId = `job-${'a'.repeat(32)}`;
    const fingerprint = 'current-fingerprint';
    const cachePath = `${servicePath}/eligibility/${cacheId}`;
    Object.assign(mocks.documents.get(proposalPath)!, {
      eligibilityStatus: 'clarification_required',
      eligibilityCacheId: cacheId,
      eligibilityFingerprint: fingerprint,
    });
    mocks.documents.set(cachePath, {
      version: CONCIERGE_ELIGIBILITY_VERSION,
      fingerprint,
      result: { status: 'clarification_required', questions: [
        { id: 'weekend', question: 'Can you work weekends?', required: true },
        { id: 'teamwork', question: 'Describe your teamwork experience.', required: true },
      ] },
    });

    const missingAnswer = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', proposalId: 'proposal-1', action: 'submitProposalInterest',
      answers: [{ questionId: 'weekend', answer: 'Yes, if scheduled ahead.' }],
    }, get: () => 'Bearer candidate-token' });
    expect(missingAnswer).toMatchObject({ status: 400, body: { error: 'proposal_answers_required' } });

    const interested = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', proposalId: 'proposal-1', action: 'submitProposalInterest',
      answers: [
        { questionId: 'weekend', answer: 'Yes, if scheduled ahead.' },
        { questionId: 'teamwork', answer: 'I have worked in a small team.' },
      ],
    }, get: () => 'Bearer candidate-token' });
    const answerDoc = mocks.documents.get(`${servicePath}/eligibility/candidate-answers-${cacheId}`);

    expect(interested.status).toBe(200);
    expect(answerDoc).toMatchObject({
      provenance: 'candidate_confirmed',
      schemaVersion: 'application-concierge-candidate-answers-v1',
      cacheId,
      eligibilityFingerprint: fingerprint,
      answers: [
        { questionId: 'weekend', question: 'Can you work weekends?', answer: 'Yes, if scheduled ahead.' },
        { questionId: 'teamwork', question: 'Describe your teamwork experience.', answer: 'I have worked in a small team.' },
      ],
    });
    expect(answerDoc?.confirmedAt).toBeInstanceOf(Date);
    expect(mocks.documents.get(proposalPath)).toMatchObject({ candidateInterestStatus: 'interested' });
    expect(mocks.documents.get(servicePath)).toMatchObject({ eligibilityFactsRevision: 1, matchingStatus: 'queued' });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);

    const blockedAcceptance = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', proposalId: 'proposal-1', action: 'acceptProposal',
    }, get: () => 'Bearer candidate-token' });
    expect(blockedAcceptance).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);

    mocks.documents.get(servicePath)!.matchingStatus = 'complete';
    mocks.documents.get(proposalPath)!.eligibilityFactsRevision = 1;
    mocks.documents.get(proposalPath)!.eligibilityStatus = 'compatible';
    const accepted = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', proposalId: 'proposal-1', action: 'acceptProposal',
    }, get: () => 'Bearer candidate-token' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.childApplicationId).toBe('child-1');
    expect(mocks.documents.get(proposalPath)).toMatchObject({ status: 'accepted', candidateInterestStatus: 'interested' });
    expect(mocks.documents.get('assisted_applications/child-1')).toMatchObject({ parentProposalId: 'proposal-1' });
  });

  it('stores an optional decline category as a weak feedback signal and increments ranking revision', async () => {
    const result = await handleApplicationConcierge({ method: 'POST', body: {
      serviceId: 'service-1', proposalId: 'proposal-1', action: 'declineProposal', declineReason: 'location',
    }, get: () => 'Bearer candidate-token' });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1'))
      .toMatchObject({ status: 'declined', declineReason: 'location' });
    expect(mocks.documents.get('application_concierge_services/service-1'))
      .toMatchObject({ matchingFeedbackRevision: 1, matchingOpenProposalCount: 0, matchingStatus: 'queued' });
    expect([...mocks.documents.keys()].some(path => path.startsWith('assisted_applications/'))).toBe(false);
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
        applicantLocationCountry: '',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      applicantName: 'Candidate Updated',
      applicantEmail: 'updated@example.test',
      applicantLocation: 'Mendrisio 6850',
      applicantLocationCountry: null,
      matchingStatus: 'queued',
      consentVersion: 'application-concierge-v1',
    }));
    expect((result.body as any).service.applicantLocation).toBe('Mendrisio 6850');
    expect((result.body as any).service.applicantLocationCountry).toBeNull();
  });

  it('returns a legacy residence without inventing or persisting country confirmation', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.applicantLocation = 'Como, Italia';

    const result = await handleApplicationConcierge({
      method: 'GET',
      query: { serviceId: 'service-1' },
      get: () => 'Bearer candidate-token',
    });

    expect((result.body as any).service).toMatchObject({
      applicantLocation: 'Como, Italia',
      applicantLocationCountry: null,
    });
    expect(service).not.toHaveProperty('applicantLocationCountry');
  });

  it('persists only the selected country and updates it when the candidate changes country', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.applicantLocation = 'Como, Italia';
    service.applicantLocationCountry = 'IT';

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        applicantLocation: 'Como, France',
        applicantLocationCountry: 'FR',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      applicantLocation: 'Como, France',
      applicantLocationCountry: 'FR',
      matchingStatus: 'queued',
    }));
    expect((result.body as any).service.applicantLocationCountry).toBe('FR');
  });

  it('confirms a legacy country without queueing unchanged matching input', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.applicantLocation = 'Como, Italia';
    service.matchingStatus = 'complete';
    service.matchingJobCount = 2;

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        applicantLocation: 'Como, Italia',
        applicantLocationCountry: 'IT',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')).toMatchObject({
      applicantLocation: 'Como, Italia',
      applicantLocationCountry: 'IT',
      matchingStatus: 'complete',
      matchingJobCount: 2,
    });
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
    eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
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

  it('reports the legacy open-proposal count before a matching run initializes its counter', async () => {
    delete mocks.documents.get('application_concierge_services/service-1')!.matchingOpenProposalCount;
    mocks.documents.set('application_concierge_services/service-1/proposals/proposal-2', {
      jobId: 'job-2', jobUrl: 'https://jobs.example.test/job-2', jobTitle: 'Analyst', status: 'proposed',
    });

    const result = await handleApplicationConcierge({
      method: 'GET', query: { serviceId: 'service-1' }, get: () => 'Bearer candidate-token',
    });

    expect((result.body as any).service.openProposalsCount).toBe(2);
    expect((result.body as any).service.maxOpenProposals).toBe(3);
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

describe('admin-created concierge proposals', () => {
  const request = {
    method: 'POST',
    body: {
      action: 'createProposal',
      serviceId: 'service-1',
      jobId: 'job-admin',
      jobUrl: 'https://jobs.example.test/admin',
      companyId: 'company-1',
      companyName: 'Example SA',
      jobTitle: 'Customer Service Specialist',
    },
  };

  it('stores the candidate facts revision used for eligibility', async () => {
    mocks.documents.get('application_concierge_services/service-1')!.eligibilityFactsRevision = 3;
    (prepareConciergeEligibility as any).mockResolvedValue(async () => ({
      status: 'compatible', cacheId: `job-${'a'.repeat(32)}`, fingerprint: 'admin-fingerprint',
    }));

    const result = await handleManageApplicationConcierge(request);
    const created = [...mocks.documents.entries()].find(([path, value]) =>
      path.startsWith('application_concierge_services/service-1/proposals/') && value.jobUrl === request.body.jobUrl)?.[1];

    expect(result.status).toBe(200);
    expect(created).toMatchObject({ eligibilityFactsRevision: 3, eligibilityStatus: 'compatible' });
  });

  it('rejects proposal creation when candidate facts change during eligibility evaluation', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.eligibilityFactsRevision = 3;
    (prepareConciergeEligibility as any).mockImplementation(async () => async () => {
      service.eligibilityFactsRevision = 4;
      return { status: 'compatible', cacheId: `job-${'a'.repeat(32)}`, fingerprint: 'stale-admin-fingerprint' };
    });

    const result = await handleManageApplicationConcierge(request);

    expect(result).toMatchObject({ status: 409, body: { error: 'proposal_requires_verification' } });
    expect([...mocks.documents.entries()].some(([path, value]) =>
      path.startsWith('application_concierge_services/service-1/proposals/') && value.jobUrl === request.body.jobUrl)).toBe(false);
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
  it('projects a candidate-safe employer response timeline onto the parent Concierge proposal', async () => {
    acceptedChild({ employerResponseTimeline: [
      { category: 'auto_acknowledgement', receivedAt: 1000, needsReply: false, messageId: 'private-ack' },
      { category: 'interview_invite', receivedAt: 2000, needsReply: true, messageId: 'private-invite' },
    ] });
    const status = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(status.body.service.proposals[0]).toMatchObject({
      childEmployerResponse: null,
      childEmployerResponseTimeline: [
        { category: 'auto_acknowledgement', receivedAt: 1000, needsReply: false },
        { category: 'interview_invite', receivedAt: 2000, needsReply: true },
      ],
    });
    expect(JSON.stringify(status.body.service.proposals[0].childEmployerResponseTimeline)).not.toContain('private-');
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
  it('exposes provider acceptance and delivery evidence for parent receipts to admins', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.notifications = {
      concierge_paid_customer: {
        status: 'sent', providerStatus: 'accepted', provider: 'maileroo', messageId: 'receipt-1',
        sentAt: new Date('2026-10-01T10:00:00Z'),
      },
    };
    service.emailEngagement = {
      concierge_paid_customer: {
        providerAccepted: 1, delivered: 1,
        providerAcceptedAt: new Date('2026-10-01T10:00:01Z'),
        deliveredAt: new Date('2026-10-01T10:00:02Z'),
      },
    };
    const admin = await handleManageApplicationConcierge({ method: 'GET' });
    expect(admin).toMatchObject({ status: 200, body: {
      services: [expect.objectContaining({ paidReceiptEmails: expect.arrayContaining([
        expect.objectContaining({ audience: 'customer', providerStatus: 'accepted', deliveryStatus: 'delivered', provider: 'maileroo', providerAccepted: 1, delivered: 1 }),
      ]) })],
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
