import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner decision 2026-11-11: a concierge proposal the candidate leaves undecided for 12 hours is accepted by
// the platform through the candidate's own acceptance path. Synthetic records only, no candidate data.
const mocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const files = new Set<string>();
  const fileMetadata = new Map<string, Record<string, unknown>>();
  let storageGeneration = 0;
  let childSequence = 0;
  let copyHook: (() => Promise<void> | void) | null = null;

  const pathKey = (path: string) => path.replace(/^\/+|\/+$/g, '');

  function mergeData(path: string, data: Record<string, unknown>, merge = false) {
    const normalized = pathKey(path);
    const next: Record<string, unknown> = merge ? { ...(documents.get(normalized) || {}) } : {};
    for (const [field, value] of Object.entries(data)) {
      if (value === '__delete__') delete next[field];
      else if (value && typeof value === 'object' && (value as any).__increment !== undefined) {
        next[field] = Number(next[field] || 0) + Number((value as any).__increment);
      } else next[field] = value;
    }
    documents.set(normalized, next);
  }

  function makeDocRef(path: string): any {
    const normalized = pathKey(path);
    const id = normalized.split('/').pop();
    return {
      id,
      path: normalized,
      async get() {
        const data = documents.get(normalized);
        return { id, ref: makeDocRef(normalized), exists: Boolean(data), data: () => data };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) { mergeData(normalized, data, options?.merge === true); },
      async delete() { documents.delete(normalized); },
      collection(name: string) { return makeCollection(`${normalized}/${name}`); },
    };
  }

  function makeCollection(path: string, filters: Array<[string, unknown]> = []): any {
    const normalized = pathKey(path);
    return {
      doc(id?: string) { return makeDocRef(`${normalized}/${id || `child-${++childSequence}`}`); },
      where(field: string, op: string, value: unknown) {
        if (op !== '==') throw new Error(`unsupported operator ${op}`);
        return makeCollection(normalized, [...filters, [field, value]]);
      },
      async get() {
        const prefix = `${normalized}/`;
        const docs = [...documents.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
          .map(([key]) => {
            const ref = makeDocRef(key);
            return { id: ref.id, ref, exists: true, data: () => documents.get(key) };
          });
        return { docs, empty: docs.length === 0 };
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
        set(ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) { operations.push(() => ref.set(data, options)); },
        async commit() { operations.forEach(operation => operation()); },
      };
    },
  };

  const bucket = {
    file(path: string) {
      return {
        path,
        async exists() { return [files.has(path)]; },
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
          await copyHook?.();
        },
        async delete() { files.delete(path); fileMetadata.delete(path); },
      };
    },
  };

  return {
    documents,
    files,
    firestore,
    bucket,
    setCopyHook(hook: (() => Promise<void> | void) | null) { copyHook = hook; },
    getAdminDb: vi.fn(() => firestore),
    getStorage: vi.fn(() => ({ bucket: () => bucket })),
    verifyCaller: vi.fn(async () => ({ uid: 'candidate-1' })),
    reset() {
      documents.clear(); files.clear(); fileMetadata.clear();
      storageGeneration = 0; childSequence = 0; copyHook = null;
    },
  };
});

vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
    delete: () => '__delete__',
  },
  FieldPath: { documentId: () => '__name__' },
  Timestamp: { now: () => new Date(), fromMillis: (value: number) => new Date(value) },
}));
vi.mock('firebase-admin/storage', () => ({ getStorage: mocks.getStorage }));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: mocks.getAdminDb }));
vi.mock('../functions/src/adminAuth.js', () => ({ assertSiteAdmin: vi.fn(async () => ({ ok: false, status: 403, error: 'forbidden' })) }));
vi.mock('../functions/src/stripePublisherCore.js', () => ({ verifyCaller: mocks.verifyCaller }));
vi.mock('../functions/src/assistedApplicationCheckout.js', () => ({ ASSISTED_APPLICATION_CONSENT_VERSION: 'assisted-application-v1' }));
vi.mock('../functions/src/applicationConciergeRenewalRollout.js', () => ({ isApplicationConciergeRenewalEnabledFor: vi.fn(async () => false) }));
vi.mock('../functions/src/assistedApplicationCvCheck.js', () => ({ ASSISTED_APPLICATION_STORAGE_BUCKET: 'test-bucket' }));
vi.mock('../functions/src/applicationConciergeEligibility.js', () => ({
  CONCIERGE_ELIGIBILITY_VERSION: 'eligibility-test-v1',
  CONCIERGE_ELIGIBILITY_UNRESOLVED_STATUS: 'unresolved',
  CONCIERGE_ELIGIBILITY_UNRESOLVED_REASON: 'eligibility_unresolved',
  CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID: 'candidate-language-facts',
  candidateAnswersDocumentId: (cacheId: string) => `candidate-answers-${String(cacheId || '').slice(0, 60)}`,
  candidateFactsDependency: (requirements: any, cached: any = null, result: any = null) => ({
    languages: Array.isArray(requirements?.languageRequirements) && requirements.languageRequirements.length > 0,
    answers: Boolean(cached?.candidateAnswerQuestionSetHash || result?.questions?.some((question: any) => question?.required === true)),
  }),
  eligibilityHash: (value: string) => String(value).length.toString(16),
  prepareConciergeEligibility: vi.fn(),
}));

const { handleApplicationConcierge, autoAcceptApplicationConciergeProposal } = await import('../functions/src/applicationConciergeCore.js');
const { runConciergeAutoAcceptSweep } = await import('../functions/src/applicationConciergeAutoAccept.js');
const { CONCIERGE_AUTO_ACCEPT_MS } = await import('../functions/src/applicationConciergeLifecyclePolicy.js');

const HOUR = 60 * 60 * 1000;
const SERVICES = 'application_concierge_services';

function seedService(serviceId = 'service-1', patch: Record<string, unknown> = {}) {
  const cvStorageKey = `application-concierge-uploads/${serviceId}/cv.pdf`;
  mocks.documents.set(`${SERVICES}/${serviceId}`, {
    userId: `candidate-${serviceId.split('-').pop()}`,
    paymentStatus: 'paid',
    serviceStatus: 'active',
    maxPositions: 10,
    acceptedPositionsCount: 0,
    currency: 'eur',
    customerEmail: 'person@example.test',
    applicantName: 'Test Person',
    applicantEmail: 'person@example.test',
    consentVersion: 'application-concierge-v1',
    consentedAt: new Date(Date.now() - 48 * HOUR),
    cvStorageKey,
    expiresAt: new Date(Date.now() + 10 * 24 * HOUR),
    ...patch,
  });
  mocks.files.add(cvStorageKey);
}

function seedProposal(serviceId: string, proposalId: string, ageMs: number, patch: Record<string, unknown> = {}) {
  const openedAt = new Date(Date.now() - ageMs);
  mocks.documents.set(`${SERVICES}/${serviceId}/proposals/${proposalId}`, {
    jobId: `job-${proposalId}`,
    jobUrl: `https://jobs.example.test/${proposalId}`,
    companyId: 'company-1',
    companyName: 'Example SA',
    jobTitle: 'Sales Support',
    location: 'Lugano',
    applyMode: 'portal',
    status: 'proposed',
    eligibilityStatus: 'compatible',
    eligibilityVersion: 'eligibility-test-v1',
    eligibilityCvStorageKey: `application-concierge-uploads/${serviceId}/cv.pdf`,
    proposedAt: openedAt,
    createdAt: openedAt,
    eligibilityAcceptableSince: openedAt,
    proposalNoticeSentAt: openedAt,
    ...patch,
  });
}

const proposal = (serviceId: string, proposalId: string) => mocks.documents.get(`${SERVICES}/${serviceId}/proposals/${proposalId}`)!;
const service = (serviceId: string) => mocks.documents.get(`${SERVICES}/${serviceId}`)!;
const children = () => [...mocks.documents.entries()].filter(([key]) => /^assisted_applications\/[^/]+$/.test(key)).map(([, data]) => data);
const sweep = (options: Record<string, unknown> = {}) => runConciergeAutoAcceptSweep({ db: mocks.firestore as any, postingClosed: null, ...options });

beforeEach(() => {
  mocks.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  seedService();
});

describe('platform acceptance of an undecided concierge proposal', () => {
  it('waits while the 12-hour window is open', async () => {
    seedProposal('service-1', 'proposal-1', 11 * HOUR);
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 0, attempted: 0, accepted: 0 });
    expect(proposal('service-1', 'proposal-1')).toMatchObject({ status: 'proposed' });
    expect(proposal('service-1', 'proposal-1').decidedBy).toBeUndefined();
    expect(children()).toHaveLength(0);
  });

  it('accepts after 12 hours through the candidate path and records who decided and when', async () => {
    expect(CONCIERGE_AUTO_ACCEPT_MS).toBe(12 * HOUR);
    seedProposal('service-1', 'proposal-1', 12 * HOUR + 60_000);
    const before = Date.now();
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 1, attempted: 1, accepted: 1, failed: 0 });
    const accepted = proposal('service-1', 'proposal-1');
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy: 'platform_timeout', childApplicationId: 'child-1' });
    expect((accepted.decidedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(service('service-1')).toMatchObject({ acceptedPositionsCount: 1, matchingStatus: 'queued' });
    expect(children()).toEqual([expect.objectContaining({
      billingMode: 'application_concierge', parentServiceId: 'service-1', parentProposalId: 'proposal-1',
      userId: 'candidate-1', paymentStatus: 'paid', submissionStatus: 'awaiting_upload',
    })]);
  });

  it('never touches a declined, withdrawn, retracted or expired proposal', async () => {
    seedProposal('service-1', 'declined', 30 * HOUR, { status: 'declined', decidedBy: 'candidate' });
    seedProposal('service-1', 'withdrawn', 30 * HOUR, { status: 'declined', withdrawnAt: new Date() });
    seedProposal('service-1', 'retracted', 30 * HOUR, { status: 'retracted' });
    seedProposal('service-1', 'expired', 30 * HOUR, { status: 'expired' });
    const snapshot = JSON.stringify([...mocks.documents.entries()]);
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 0, attempted: 0, accepted: 0 });
    expect(JSON.stringify([...mocks.documents.entries()])).toBe(snapshot);
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - HOUR) }, null],
    ['suspended', { serviceStatus: 'suspended' }, null],
    ['refunded', { refundedAt: new Date(), refundStatus: 'refunded' }, 'service_refunded'],
    ['out of quota', { acceptedPositionsCount: 10 }, 'quota_exhausted'],
  ])('leaves an %s service alone', async (_label, patch, reason) => {
    seedService('service-1', patch);
    seedProposal('service-1', 'proposal-1', 30 * HOUR);
    const summary = await sweep();
    expect(summary.accepted).toBe(0);
    expect(summary.attempted).toBe(0);
    if (reason) expect(summary.skipped).toEqual({ [reason]: 1 });
    expect(proposal('service-1', 'proposal-1')).toMatchObject({ status: 'proposed' });
    expect(children()).toHaveLength(0);
  });

  it('is idempotent across two ticks: one child, one position', async () => {
    seedProposal('service-1', 'proposal-1', 20 * HOUR);
    const first = await sweep();
    const second = await sweep();
    expect(first.accepted).toBe(1);
    expect(second).toMatchObject({ due: 0, attempted: 0, accepted: 0 });
    expect(children()).toHaveLength(1);
    expect(service('service-1').acceptedPositionsCount).toBe(1);
  });

  it('a candidate who declines while the platform copies the CV wins', async () => {
    seedProposal('service-1', 'proposal-1', 20 * HOUR);
    mocks.setCopyHook(async () => {
      mocks.setCopyHook(null);
      const declined = await handleApplicationConcierge({ method: 'POST', body: {
        action: 'declineProposal', serviceId: 'service-1', proposalId: 'proposal-1', declineReason: 'role',
      } });
      expect(declined.status).toBe(200);
    });
    const summary = await sweep();
    expect(summary.accepted).toBe(0);
    expect(Object.keys(summary.skipped)).toHaveLength(1);
    expect(proposal('service-1', 'proposal-1')).toMatchObject({ status: 'declined', decidedBy: 'candidate', declineReason: 'role' });
    expect(proposal('service-1', 'proposal-1').childApplicationId).toBeUndefined();
    expect(children()).toHaveLength(0);
    expect(service('service-1').acceptedPositionsCount).toBe(0);
  });

  it('a candidate who already decided before the tick keeps that decision', async () => {
    seedProposal('service-1', 'proposal-1', 20 * HOUR);
    const declined = await handleApplicationConcierge({ method: 'POST', body: {
      action: 'declineProposal', serviceId: 'service-1', proposalId: 'proposal-1',
    } });
    expect(declined.status).toBe(200);
    expect(await autoAcceptApplicationConciergeProposal({ db: mocks.firestore as any, serviceId: 'service-1', proposalId: 'proposal-1' }))
      .toEqual({ accepted: false, reason: 'proposal_already_decided' });
    expect(children()).toHaveLength(0);
  });

  it('refuses a platform acceptance before the window has elapsed, even when asked directly', async () => {
    seedProposal('service-1', 'proposal-1', 2 * HOUR);
    expect(await autoAcceptApplicationConciergeProposal({ db: mocks.firestore as any, serviceId: 'service-1', proposalId: 'proposal-1' }))
      .toEqual({ accepted: false, reason: 'auto_accept_not_due' });
    // A retracted proposal offered again opens a new window.
    const reactivatedAt = new Date(Date.now() - HOUR);
    seedProposal('service-1', 'proposal-2', 30 * HOUR, {
      reactivatedAt,
      eligibilityAcceptableSince: reactivatedAt,
      proposalNoticeSentAt: reactivatedAt,
    });
    expect((await sweep()).due).toBe(0);
    expect(children()).toHaveLength(0);
  });

  it('holds a proposal whose ad says it is closed and does not look again on the next tick', async () => {
    seedProposal('service-1', 'proposal-1', 20 * HOUR);
    const postingClosed = vi.fn(async () => true);
    const first = await sweep({ postingClosed });
    expect(first).toMatchObject({ accepted: 0, skipped: { posting_closed: 1 } });
    expect(proposal('service-1', 'proposal-1')).toMatchObject({ status: 'proposed', autoAcceptHold: { reason: 'posting_closed' } });
    const second = await sweep({ postingClosed });
    expect(second).toMatchObject({ accepted: 0, attempted: 0, skipped: { posting_closed: 1 } });
    expect(postingClosed).toHaveBeenCalledTimes(1);
    expect(children()).toHaveLength(0);
  });

  it('caps the attempts of one tick and accepts the backlog on the following ticks', async () => {
    for (const id of ['service-1', 'service-2', 'service-3']) {
      seedService(id);
      seedProposal(id, 'proposal-1', 40 * HOUR);
    }
    const first = await sweep({ maxPerTick: 2 });
    expect(first).toMatchObject({ due: 3, attempted: 2, accepted: 2, deferred: 1 });
    expect(console.log).toHaveBeenCalledWith('[conciergeAutoAccept]', expect.stringContaining('"accepted":2'));
    const second = await sweep({ maxPerTick: 2 });
    expect(second).toMatchObject({ due: 1, accepted: 1, deferred: 0 });
    expect(children()).toHaveLength(3);
  });

  it('accepts one proposal per service per tick, the oldest first, as the candidate button would', async () => {
    seedProposal('service-1', 'newer', 13 * HOUR);
    seedProposal('service-1', 'older', 30 * HOUR);
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 2, attempted: 1, accepted: 1, deferred: 1 });
    expect(proposal('service-1', 'older')).toMatchObject({ status: 'accepted', decidedBy: 'platform_timeout' });
    expect(proposal('service-1', 'newer')).toMatchObject({ status: 'proposed' });
  });

  it('does not check or attempt an unacceptable proposal and still accepts a compatible one', async () => {
    seedProposal('service-1', 'unverified', 40 * HOUR, { eligibilityStatus: 'unverified' });
    seedProposal('service-1', 'compatible', 13 * HOUR);
    const postingClosed = vi.fn(async () => false);
    const summary = await sweep({ postingClosed });
    expect(summary).toMatchObject({ due: 1, attempted: 1, accepted: 1, deferred: 0 });
    expect(postingClosed).toHaveBeenCalledTimes(1);
    expect(proposal('service-1', 'unverified')).toMatchObject({ status: 'proposed' });
    expect(proposal('service-1', 'compatible')).toMatchObject({ status: 'accepted', decidedBy: 'platform_timeout' });
  });

  it('shows the candidate when the platform will accept, and who decided afterwards', async () => {
    seedProposal('service-1', 'proposal-1', 2 * HOUR);
    const proposedAt = (proposal('service-1', 'proposal-1').proposedAt as Date).getTime();
    const before = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(before.body.service.proposals[0]).toMatchObject({
      status: 'proposed', autoAcceptAt: new Date(proposedAt + 12 * HOUR).toISOString(), decidedBy: null,
    });
    seedProposal('service-1', 'proposal-1', 13 * HOUR);
    await sweep();
    const after = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(after.body.service.proposals[0]).toMatchObject({ status: 'accepted', autoAcceptAt: null, decidedBy: 'platform_timeout' });
  });

  it.each(['queued', 'running', 'failed', 'needs_review'])('accepts a verified proposal while the service matcher is %s', async matchingStatus => {
    seedService('service-1', { matchingStatus });
    seedProposal('service-1', 'proposal-1', 13 * HOUR);
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 1, attempted: 1, accepted: 1 });
    expect(proposal('service-1', 'proposal-1')).toMatchObject({ status: 'accepted', decidedBy: 'platform_timeout' });
  });

  it('invalidates only a proposal whose recorded candidate-fact dependency changed', async () => {
    seedService('service-1', { eligibilityFactsRevision: 1, eligibilityLanguagesRevision: 1, matchingStatus: 'queued' });
    seedProposal('service-1', 'independent', 13 * HOUR, {
      eligibilityFactsRevision: 0,
      eligibilityFactsDependency: { languages: false, answers: false },
    });
    seedProposal('service-1', 'language-dependent', 20 * HOUR, {
      eligibilityFactsRevision: 0,
      eligibilityFactsDependency: { languages: true, answers: false },
      eligibilityLanguagesRevision: 0,
      eligibilityAnswersRevision: 0,
    });
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 1, attempted: 1, accepted: 1 });
    expect(proposal('service-1', 'independent')).toMatchObject({ status: 'accepted' });
    expect(proposal('service-1', 'language-dependent')).toMatchObject({ status: 'proposed' });
  });

  it('does not start the 12-hour timer until the announcement is proven', async () => {
    seedProposal('service-1', 'proposal-1', 30 * HOUR, { proposalNoticeSentAt: null });
    const listed = await handleApplicationConcierge({ method: 'GET', query: { serviceId: 'service-1' } });
    expect(listed.body.service.proposals[0]).toMatchObject({ status: 'proposed', autoAcceptAt: null });
    const summary = await sweep();
    expect(summary).toMatchObject({ due: 0, attempted: 0, accepted: 0 });
  });
});
