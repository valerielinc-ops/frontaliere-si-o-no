import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS } from '../functions/src/applicationConciergeConstants.js';
import { eligibilityRetryRef } from '../functions/src/applicationConciergeEligibilityRetry.js';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: { now: () => new Date() },
}));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: vi.fn() }));
vi.mock('../functions/src/applicationConciergeEligibility.js', () => ({
  CONCIERGE_ELIGIBILITY_VERSION: 'test-eligibility-v1',
  normalizeConciergeJobRecord: (job: any) => ({
    ...job,
    id: job.id || job.jobId || '',
    url: job.url || job.jobUrl || job.applyUrl || job.canonicalUrl || '',
    title: job.title || job.jobTitle || '',
    company: job.company || job.companyName || '',
    location: job.location || '',
  }),
  prepareConciergeEligibility: vi.fn(),
}));

const {
  APPLICATION_CONCIERGE_MATCHING_VERSION,
  approvedRolePreference,
  eligibilityRetryContext,
  rankingFeaturesForJob,
  rankingFeedbackContext,
  rankingFeedbackPreference,
  runApplicationConciergeMatching,
} = await import('../functions/src/applicationConciergeMatching.js');

const SERVICE_ID = 'service-1';
const SERVICE_PATH = `application_concierge_services/${SERVICE_ID}`;
const PROPOSAL_PATH = `${SERVICE_PATH}/proposals/proposal-1`;
const JOB_URL = 'https://jobs.example.test/it-manager-sap';
const CV_KEY = `application-concierge-uploads/${SERVICE_ID}/cv.pdf`;

function matchingFixture() {
  return createMemoryFirestore({
    [SERVICE_PATH]: {
      userId: 'candidate-1',
      paymentStatus: 'paid',
      serviceStatus: 'active',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      cvStorageKey: CV_KEY,
      maxPositions: 10,
      acceptedPositionsCount: 0,
      matchingStatus: 'complete',
    },
    'user_cv_profiles/candidate-1': {
      status: 'ready',
      profile: { searchText: 'IT Manager SAP', workPosition: 'IT Manager', skills: ['SAP'] },
    },
    [PROPOSAL_PATH]: {
      jobId: 'job-1',
      jobUrl: JOB_URL,
      companyName: 'Example AG',
      jobTitle: 'IT Manager SAP',
      status: 'proposed',
      eligibilityStatus: 'compatible',
      eligibilityVersion: 'test-eligibility-v1',
      eligibilityCvStorageKey: CV_KEY,
      matchScore: 72,
    },
  });
}

function legacyEligibilityRecoveryContext(profile: unknown, candidateLocation = '', factsRevision = 0) {
  return createHash('sha256').update(JSON.stringify([
    'test-eligibility-v1',
    APPLICATION_CONCIERGE_MATCHING_VERSION,
    CV_KEY,
    profile,
    candidateLocation,
    ...(factsRevision > 0 ? [factsRevision] : []),
  ])).digest('hex');
}

function stubJobIndex(jobs: unknown[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => jobs }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const matchingJob = { id: 'job-1', url: JOB_URL, title: 'IT Manager SAP', company: 'Example AG' };

function serializeTransactions(store: ReturnType<typeof createMemoryFirestore>) {
  const run = store.db.runTransaction.bind(store.db);
  let queue = Promise.resolve();
  store.db.runTransaction = (callback: (transaction: any) => Promise<unknown>) => {
    const result = queue.then(() => run(callback));
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('application concierge proposal retention', () => {
  it('applies the product-wide position cap to legacy services with a larger stored limit', async () => {
    const store = matchingFixture();
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH), maxPositions: 20, acceptedPositionsCount: 10 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runApplicationConciergeMatching({
      db: store.db,
      serviceId: SERVICE_ID,
      jobIndexUrl: 'https://jobs.example.test/index',
    })).resolves.toEqual({ status: 'skipped', reason: 'position_limit_reached' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'proposed' });
  });

  it('preserves existing proposals if retrieving the job index fails', async () => {
    const store = matchingFixture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('job_index_unavailable'); }));

    await expect(runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, jobIndexUrl: 'https://jobs.example.test/index' }))
      .rejects.toThrow('job_index_unavailable');

    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'proposed', eligibilityStatus: 'compatible' });
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingStatus: 'failed' });
  });

  it('keeps a proposal visible but marks it unverified when the current index omits the job', async () => {
    const store = matchingFixture();
    const fetchMock = stubJobIndex([]);
    const eligibility = vi.fn();

    const result = await runApplicationConciergeMatching({
      db: store.db,
      serviceId: SERVICE_ID,
      jobIndexUrl: 'https://jobs.example.test/index',
      eligibility,
    });

    expect(result).toMatchObject({ status: 'complete', retracted: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(eligibility).not.toHaveBeenCalled();
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'proposed', eligibilityStatus: 'unverified', matchScore: 72 });
  });

  it('never publishes a new proposal when eligibility remains unknown', async () => {
    const store = matchingFixture();
    store.docs.delete(PROPOSAL_PATH);
    stubJobIndex([matchingJob]);
    const eligibility = vi.fn(async () => ({ status: 'unverified', reason: 'posting_unavailable' }));

    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(result).toMatchObject({ status: 'complete', proposals: 0 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(store.list(`${SERVICE_PATH}/proposals/`)).toEqual([]);
  });

  it('replaces stale aggregate reason and status maps when the retry queue changes', async () => {
    const store = matchingFixture();
    store.docs.set(SERVICE_PATH, {
      ...store.read(SERVICE_PATH)!,
      matchingPendingReasonCounts: { stale_frontier: 3 },
      matchingRetryReasonCounts: { posting_unavailable: 4, obsolete_reason: 1 },
      matchingRetryStatusCounts: { unverified: 4, unknown: 1 },
    });
    stubJobIndex([]);

    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility: vi.fn() });
    const service = store.read(SERVICE_PATH)!;

    expect(result).toMatchObject({ status: 'complete', proposals: 0 });
    expect(service.matchingPendingReasonCounts).toEqual({});
    expect(service.matchingRetryReasonCounts).toEqual({});
    expect(service.matchingRetryStatusCounts).toEqual({});
  });

  it('reopens exhausted eligibility only when the primary posting fingerprint changes', async () => {
    const store = matchingFixture();
    store.docs.delete(PROPOSAL_PATH);
    stubJobIndex([matchingJob]);
    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const scanContext = createHash('sha256').update(JSON.stringify(['test-eligibility-v1', CV_KEY, profile])).digest('hex');
    const jobContext = eligibilityRetryContext(scanContext, { ...matchingJob, location: '' });
    const originalFingerprint = 'a'.repeat(64);
    const verifiedFingerprint = 'b'.repeat(64);
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    const retryRef = eligibilityRetryRef(serviceRef, JOB_URL);
    await retryRef.set({
      jobUrl: JOB_URL,
      context: eligibilityRetryContext(scanContext, { ...matchingJob, location: '' }, originalFingerprint),
      jobContext,
      fingerprint: originalFingerprint,
      attempts: 5,
      deferrals: 0,
      retryAt: 0,
      retryState: 'exhausted',
      lastStatus: 'unverified',
      lastReason: 'posting_unavailable',
      firstAttemptAt: Date.now() - 5 * 86400000,
      lastAttemptAt: Date.now(),
    });

    let currentFingerprint = originalFingerprint;
    const fingerprintFor = vi.fn(async () => currentFingerprint);
    const eligibility = Object.assign(vi.fn(async () => ({ status: 'compatible', fingerprint: verifiedFingerprint })),
      { fingerprintFor });

    const unchanged = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(fingerprintFor).toHaveBeenCalledTimes(1);
    expect(eligibility).not.toHaveBeenCalled();
    expect(unchanged).toMatchObject({ status: 'complete', proposals: 0 });
    expect((await retryRef.get()).data()).toMatchObject({ retryState: 'exhausted', lastReason: 'posting_unavailable' });

    currentFingerprint = verifiedFingerprint;
    const recovered = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(recovered).toMatchObject({ status: 'complete', proposals: 1 });
    expect(fingerprintFor).toHaveBeenCalledTimes(2);
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect((await retryRef.get()).exists).toBe(false);
    expect(store.read(SERVICE_PATH)).toMatchObject({
      matchingEligibilityRecoveryCount: 1,
      matchingEligibilityLastRecoveryStatus: 'compatible',
    });
    expect(store.list(`${SERVICE_PATH}/proposals/`)).toHaveLength(1);
  });

  it('retries only exhausted eligibility whose per-listing posting fingerprint changed', async () => {
    const store = matchingFixture();
    store.docs.delete(PROPOSAL_PATH);
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 1 });
    const unrelatedUrl = 'https://jobs.example.test/it-manager-legacy-retry';
    const unrelatedJob = { ...matchingJob, id: 'job-2', url: unrelatedUrl };
    stubJobIndex([matchingJob, unrelatedJob]);

    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const eligibilityContext = createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile,
      1,
    ])).digest('hex');
    const retryBudgetContext = createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile,
    ])).digest('hex');
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    const relevantRetryRef = eligibilityRetryRef(serviceRef, JOB_URL);
    const unrelatedRetryRef = eligibilityRetryRef(serviceRef, unrelatedUrl);
    const seedExhaustedRetry = async (url: string, job: typeof matchingJob, fingerprint: string) => {
      const normalizedJob = { ...job, location: '' };
      const retryContext = url === JOB_URL ? eligibilityContext : retryBudgetContext;
      await eligibilityRetryRef(serviceRef, url).set({
        jobUrl: url,
        context: eligibilityRetryContext(retryContext, normalizedJob, fingerprint),
        jobContext: eligibilityRetryContext(retryContext, normalizedJob),
        retryBudgetContext: eligibilityRetryContext(retryBudgetContext, normalizedJob, fingerprint),
        retryBudgetJobContext: eligibilityRetryContext(retryBudgetContext, normalizedJob),
        eligibilityFactsRevision: 1,
        candidateFactsDependency: { languages: url === JOB_URL, answers: false },
        fingerprint,
        attempts: 5,
        deferrals: 0,
        retryAt: 0,
        retryState: 'exhausted',
        lastStatus: 'unverified',
        lastReason: 'posting_unavailable',
        firstAttemptAt: Date.now() - 5 * 86400000,
        lastAttemptAt: Date.now(),
      });
    };
    await seedExhaustedRetry(JOB_URL, matchingJob, 'a'.repeat(64));
    await seedExhaustedRetry(unrelatedUrl, unrelatedJob, 'd'.repeat(64));

    const fingerprintFor = vi.fn(async (job: any) => job.url === JOB_URL ? 'b'.repeat(64) : 'd'.repeat(64));
    const eligibility = Object.assign(vi.fn(async () => ({ status: 'compatible', fingerprint: 'b'.repeat(64) })), { fingerprintFor });
    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(fingerprintFor).toHaveBeenCalledTimes(2);
    expect(eligibility.mock.calls[0][0].url).toBe(JOB_URL);
    expect((await relevantRetryRef.get()).exists).toBe(false);
    expect((await unrelatedRetryRef.get()).data()).toMatchObject({
      attempts: 5,
      retryState: 'exhausted',
      lastReason: 'posting_unavailable',
    });
    expect(store.list(`${SERVICE_PATH}/proposals/`)).toHaveLength(1);
    expect(store.list(`${SERVICE_PATH}/proposals/`).map(path => store.read(path)?.eligibilityFactsRevision)).toEqual([1]);
  });

  it.each(['hard_requirement_uncovered', 'language_requirement_uncovered'])(
    'does not revive legacy %s retries after candidate facts change', async reason => {
      const store = matchingFixture();
      store.docs.delete(PROPOSAL_PATH);
      store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 1 });
      stubJobIndex([matchingJob]);
      const profile = store.read('user_cv_profiles/candidate-1')?.profile;
      const retryBudgetContext = createHash('sha256').update(JSON.stringify([
        'test-eligibility-v1', CV_KEY, profile,
      ])).digest('hex');
      const normalizedJob = { ...matchingJob, location: '' };
      const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
      const retryRef = eligibilityRetryRef(serviceRef, JOB_URL);
      const fingerprint = '8'.repeat(64);
      await retryRef.set({
        jobUrl: JOB_URL,
        context: eligibilityRetryContext(retryBudgetContext, normalizedJob, fingerprint),
        jobContext: eligibilityRetryContext(retryBudgetContext, normalizedJob),
        retryBudgetContext: eligibilityRetryContext(retryBudgetContext, normalizedJob, fingerprint),
        retryBudgetJobContext: eligibilityRetryContext(retryBudgetContext, normalizedJob),
        eligibilityFactsRevision: 1,
        fingerprint,
        attempts: 5,
        deferrals: 0,
        retryAt: 0,
        retryState: 'exhausted',
        lastStatus: 'unverified',
        lastReason: reason,
      });
      store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 2 });
      const eligibility = vi.fn(async () => ({ status: 'unverified', reason: 'provider_unavailable' }));

      const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

      expect(result).toMatchObject({ status: 'complete', proposals: 0 });
      expect(eligibility).not.toHaveBeenCalled();
      expect((await retryRef.get()).data()).toMatchObject({
        attempts: 5,
        retryState: 'exhausted',
        lastReason: reason,
        eligibilityFactsRevision: 1,
      });
    },
  );

  it('rechecks exhausted eligibility after candidate facts revision without resetting its retry budget', async () => {
    const store = matchingFixture();
    store.docs.delete(PROPOSAL_PATH);
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 1 });
    const unrelatedUrl = 'https://jobs.example.test/it-manager-facts-independent';
    const unrelatedJob = { ...matchingJob, id: 'job-2', url: unrelatedUrl };
    stubJobIndex([matchingJob, unrelatedJob]);

    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const eligibilityContextForRevision = (revision: number) => createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile, revision,
    ])).digest('hex');
    const retryBudgetContext = createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile,
    ])).digest('hex');
    const normalizedJob = { ...matchingJob, location: '' };
    const fingerprint = 'e'.repeat(64);
    const nextFingerprint = 'a'.repeat(64);
    const sourceFingerprint = 'f'.repeat(64);
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    const retryRef = eligibilityRetryRef(serviceRef, JOB_URL);
    const unrelatedRetryRef = eligibilityRetryRef(serviceRef, unrelatedUrl);
    const seedRetry = async (url: string, job: typeof matchingJob, rowFingerprint: string, languageDependent: boolean) => {
      const jobRecord = { ...job, location: '' };
      const retryScanContext = languageDependent ? eligibilityContextForRevision(1) : retryBudgetContext;
      await eligibilityRetryRef(serviceRef, url).set({
        jobUrl: url,
        context: eligibilityRetryContext(retryScanContext, jobRecord, rowFingerprint),
        jobContext: eligibilityRetryContext(retryScanContext, jobRecord),
        retryBudgetContext: eligibilityRetryContext(retryBudgetContext, jobRecord, sourceFingerprint),
        retryBudgetJobContext: eligibilityRetryContext(retryBudgetContext, jobRecord),
        eligibilityFactsRevision: 1,
        candidateFactsDependency: { languages: languageDependent, answers: false },
        fingerprint: rowFingerprint,
        sourceFingerprint,
        attempts: 5,
        deferrals: 0,
        retryAt: 0,
        retryState: 'exhausted',
        lastStatus: 'unverified',
        lastReason: 'posting_unavailable',
        firstAttemptAt: Date.now() - 5 * 86400000,
        lastAttemptAt: Date.now(),
      });
    };
    await seedRetry(JOB_URL, matchingJob, fingerprint, true);
    await seedRetry(unrelatedUrl, unrelatedJob, 'd'.repeat(64), false);
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 2 });

    let evaluatedFingerprint = fingerprint;
    const eligibility = vi.fn(async () => ({ status: 'unverified', reason: 'provider_unavailable',
      fingerprint: evaluatedFingerprint, sourceFingerprint }));
    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(result).toMatchObject({ status: 'complete', proposals: 0 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(eligibility.mock.calls[0][0].url).toBe(JOB_URL);
    expect((await retryRef.get()).data()).toMatchObject({
      attempts: 5,
      retryState: 'exhausted',
      lastReason: 'provider_unavailable',
      eligibilityFactsRevision: 2,
      retryBudgetContext: eligibilityRetryContext(retryBudgetContext, normalizedJob, sourceFingerprint),
      fingerprint,
    });
    expect((await retryRef.get()).data()?.jobContext)
      .toBe(eligibilityRetryContext(eligibilityContextForRevision(2), normalizedJob));
    expect((await unrelatedRetryRef.get()).data()).toMatchObject({
      attempts: 5,
      retryState: 'exhausted',
      eligibilityFactsRevision: 1,
      candidateFactsDependency: { languages: false, answers: false },
    });

    evaluatedFingerprint = nextFingerprint;
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 3 });
    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(eligibility).toHaveBeenCalledTimes(2);
    expect((await retryRef.get()).data()).toMatchObject({
      attempts: 5,
      retryState: 'exhausted',
      eligibilityFactsRevision: 3,
      fingerprint: nextFingerprint,
      sourceFingerprint,
    });
    expect((await unrelatedRetryRef.get()).data()).toMatchObject({ attempts: 5, retryState: 'exhausted' });
  });

  it('keeps the retry budget progression when revised candidate facts bypass an active backoff', async () => {
    const store = matchingFixture();
    store.docs.delete(PROPOSAL_PATH);
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 1 });
    stubJobIndex([matchingJob]);

    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const contextForRevision = (revision: number) => createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile, revision,
    ])).digest('hex');
    const retryBudgetContext = createHash('sha256').update(JSON.stringify([
      'test-eligibility-v1', CV_KEY, profile,
    ])).digest('hex');
    const normalizedJob = { ...matchingJob, location: '' };
    const sourceFingerprint = 'b'.repeat(64);
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    const retryRef = eligibilityRetryRef(serviceRef, JOB_URL);
    await retryRef.set({
      jobUrl: JOB_URL,
      context: eligibilityRetryContext(contextForRevision(1), normalizedJob, 'c'.repeat(64)),
      jobContext: eligibilityRetryContext(contextForRevision(1), normalizedJob),
      retryBudgetContext: eligibilityRetryContext(retryBudgetContext, normalizedJob, sourceFingerprint),
      retryBudgetJobContext: eligibilityRetryContext(retryBudgetContext, normalizedJob),
      eligibilityFactsRevision: 1,
      candidateFactsDependency: { languages: true, answers: false },
      fingerprint: 'c'.repeat(64),
      sourceFingerprint,
      attempts: 2,
      deferrals: 0,
      retryAt: Date.now() + 60 * 60_000,
      retryState: 'scheduled',
      lastStatus: 'unverified',
      lastReason: 'provider_unavailable',
      firstAttemptAt: Date.now() - 4 * 60 * 60_000,
      lastAttemptAt: Date.now() - 60 * 60_000,
    });
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, eligibilityFactsRevision: 2 });

    const eligibility = vi.fn(async () => ({
      status: 'unverified',
      reason: 'provider_unavailable',
      fingerprint: 'd'.repeat(64),
      sourceFingerprint,
    }));
    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    const retry = (await retryRef.get()).data();

    expect(result).toMatchObject({ status: 'complete', proposals: 0 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({
      attempts: 3,
      retryState: 'scheduled',
      eligibilityFactsRevision: 2,
      fingerprint: 'd'.repeat(64),
      sourceFingerprint,
      retryBudgetContext: eligibilityRetryContext(retryBudgetContext, normalizedJob, sourceFingerprint),
    });
    expect(Number(retry?.retryAt)).toBeGreaterThan(Date.now() + 3 * 60 * 60_000);
  });

  it('resumes a scheduled legacy proposal when confirmed candidate facts change', async () => {
    const store = matchingFixture();
    const originalProposal = store.read(PROPOSAL_PATH)!;
    const legacyProposal = {
      ...originalProposal,
      status: 'retracted',
      eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
      legacyRecoveryStatus: 'pending',
      legacyRecoveryAttempts: 4,
      legacyRecoveryNextAt: Date.now() + 86400000,
    };
    store.docs.set(PROPOSAL_PATH, legacyProposal);
    const service = store.read(SERVICE_PATH)!;
    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const previousRecoveryContext = legacyEligibilityRecoveryContext(profile);
    store.docs.set(SERVICE_PATH, {
      ...service,
      eligibilityFactsRevision: 1,
      matchingLegacyRecoveryContext: previousRecoveryContext,
      matchingLegacyRecoveryCursor: 'proposal-1',
    });
    store.docs.set(PROPOSAL_PATH, { ...legacyProposal, legacyRecoveryContext: previousRecoveryContext });
    stubJobIndex([matchingJob]);
    const eligibility = vi.fn(async () => ({ status: 'compatible', fingerprint: 'c'.repeat(64) }));

    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(store.read(PROPOSAL_PATH)).toMatchObject({
      status: 'proposed',
      eligibilityStatus: 'compatible',
      eligibilityFactsRevision: 1,
      legacyRecoveryStatus: 'recovered',
    });
  });

  it('does not restart a legacy eligibility backoff when ranking feedback changes', async () => {
    const store = matchingFixture();
    const profile = store.read('user_cv_profiles/candidate-1')?.profile;
    const recoveryContext = legacyEligibilityRecoveryContext(profile);
    const legacyProposal = {
      ...store.read(PROPOSAL_PATH)!,
      status: 'retracted',
      eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
      legacyRecoveryStatus: 'pending',
      legacyRecoveryContext: recoveryContext,
      legacyRecoveryAttempts: 4,
      legacyRecoveryNextAt: Date.now() + 86400000,
    };
    store.docs.set(PROPOSAL_PATH, legacyProposal);
    store.docs.set(`${SERVICE_PATH}/proposals/declined-feedback`, {
      jobId: 'job-declined',
      jobUrl: 'https://jobs.example.test/declined-feedback',
      jobTitle: 'IT Manager SAP',
      status: 'declined',
      declineReason: 'location',
    });
    store.docs.set(SERVICE_PATH, {
      ...store.read(SERVICE_PATH)!,
      matchingLegacyRecoveryContext: recoveryContext,
      matchingLegacyRecoveryCursor: 'proposal-1',
    });
    stubJobIndex([matchingJob]);
    const eligibility = vi.fn();

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(eligibility).not.toHaveBeenCalled();
    expect(store.read(PROPOSAL_PATH)).toMatchObject({
      status: 'retracted',
      legacyRecoveryContext: recoveryContext,
      legacyRecoveryAttempts: 4,
      legacyRecoveryNextAt: legacyProposal.legacyRecoveryNextAt,
    });
  });

  it('reactivates an ambiguous legacy retraction only after current listing and eligibility checks pass', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      eligibilityVersion: 'legacy-eligibility', retractionReason: 'decisive_requirements_unverified',
    });
    const eligibility = vi.fn(async () => ({ status: 'compatible', fingerprint: 'current-source-fingerprint' }));
    stubJobIndex([matchingJob]);

    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(store.read(PROPOSAL_PATH)).toMatchObject({
      status: 'proposed', eligibilityStatus: 'compatible', eligibilityVersion: 'test-eligibility-v1',
      eligibilityFingerprint: 'current-source-fingerprint', legacyRecoveryStatus: 'recovered',
      legacyRecoveryLastReason: 'verified_compatible',
    });
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingLegacyRecoveryPendingCount: 0, matchingLegacyRecoveryRetryAt: null });
  });

  it('reuses the legacy proposal when the current index assigns a new job ID to the same URL', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, jobId: 'old-job-id', status: 'retracted', eligibilityStatus: 'unverified',
      eligibilityVersion: 'legacy-eligibility', retractionReason: 'decisive_requirements_unverified',
    });
    stubJobIndex([{ ...matchingJob, id: 'republished-job-id' }]);

    const result = await runApplicationConciergeMatching({
      db: store.db, serviceId: SERVICE_ID, eligibility: vi.fn(async () => ({ status: 'compatible' })),
    });

    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    expect(store.list(`${SERVICE_PATH}/proposals/`)).toEqual([PROPOSAL_PATH]);
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'proposed', jobId: 'old-job-id', legacyRecoveryStatus: 'recovered' });
  });

  it('allows only one retracted document for a URL to return to proposed', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
    });
    const ordinaryPath = `${SERVICE_PATH}/proposals/a-ordinary-retraction`;
    store.docs.set(ordinaryPath, {
      jobId: 'previous-job-id', jobUrl: JOB_URL, jobTitle: 'IT Manager SAP',
      status: 'retracted', eligibilityStatus: 'incompatible', retractionReason: 'decisive_requirement_missing',
    });
    stubJobIndex([matchingJob]);

    const result = await runApplicationConciergeMatching({
      db: store.db, serviceId: SERVICE_ID, eligibility: vi.fn(async () => ({ status: 'compatible' })),
    });

    const proposals = store.list(`${SERVICE_PATH}/proposals/`).map(path => store.read(path));
    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    expect(proposals.filter(proposal => proposal?.status === 'proposed')).toHaveLength(1);
    expect(store.read(ordinaryPath)).toMatchObject({ status: 'proposed', eligibilityStatus: 'compatible' });
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'retracted', retractionReason: 'duplicate_proposal', legacyRecoveryStatus: 'terminal' });
  });

  it('keeps legacy retractions non-acceptable and schedules bounded retries when the listing is absent or eligibility is unknown', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      eligibilityVersion: 'legacy-eligibility', retractionReason: 'decisive_requirements_unverified',
    });
    stubJobIndex([matchingJob]);
    const eligibility = vi.fn(async () => ({ status: 'unverified', reason: 'posting_incomplete' }));

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(store.read(PROPOSAL_PATH)).toMatchObject({
      status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified', legacyRecoveryStatus: 'pending',
      legacyRecoveryAttempts: 1, legacyRecoveryLastReason: 'posting_incomplete',
    });
    expect(store.read(PROPOSAL_PATH)?.legacyRecoveryNextAt).toBeGreaterThan(Date.now());
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingLegacyRecoveryPendingCount: 1 });

    const absent = matchingFixture();
    absent.docs.set(PROPOSAL_PATH, {
      ...absent.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
    });
    stubJobIndex([]);
    const absentEligibility = vi.fn();
    await runApplicationConciergeMatching({ db: absent.db, serviceId: SERVICE_ID, eligibility: absentEligibility });
    expect(absentEligibility).not.toHaveBeenCalled();
    expect(absent.read(PROPOSAL_PATH)).toMatchObject({ status: 'retracted', eligibilityStatus: 'unverified', legacyRecoveryStatus: 'pending', legacyRecoveryLastReason: 'listing_not_in_current_index' });
  });

  it('does not turn an uncertain legacy retraction into a proven mismatch when the relevance score is low', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
    });
    stubJobIndex([{ id: 'job-1', url: JOB_URL, title: 'Chief Financial Officer', company: 'Example AG' }]);
    const eligibility = vi.fn();

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(eligibility).not.toHaveBeenCalled();
    expect(store.read(PROPOSAL_PATH)).toMatchObject({
      status: 'retracted', eligibilityStatus: 'unverified', retractionReason: 'decisive_requirements_unverified',
      legacyRecoveryStatus: 'pending', legacyRecoveryLastReason: 'match_below_threshold',
    });
  });

  it('never recovers accepted proposals and terminalizes only demonstrated closure or decisive mismatch', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
    });
    const acceptedPath = `${SERVICE_PATH}/proposals/accepted-legacy`;
    const accepted = {
      jobId: 'job-accepted', jobUrl: 'https://jobs.example.test/accepted', jobTitle: 'IT Manager SAP',
      status: 'accepted', eligibilityStatus: 'unverified', retractionReason: 'decisive_requirements_unverified',
      childApplicationId: 'application-accepted',
    };
    store.docs.set(acceptedPath, accepted);
    const closedJob = { id: 'job-1', url: JOB_URL, title: 'IT Manager SAP', company: 'Example AG', status: 'closed' };
    stubJobIndex([closedJob]);

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility: vi.fn() });

    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'retracted', retractionReason: 'job_closed', legacyRecoveryStatus: 'terminal' });
    expect(store.read(acceptedPath)).toEqual(accepted);

    const mismatch = matchingFixture();
    mismatch.docs.set(PROPOSAL_PATH, {
      ...mismatch.read(PROPOSAL_PATH)!, status: 'retracted', eligibilityStatus: 'unverified',
      retractionReason: 'decisive_requirements_unverified',
    });
    stubJobIndex([matchingJob]);
    await runApplicationConciergeMatching({ db: mismatch.db, serviceId: SERVICE_ID, eligibility: vi.fn(async () => ({
      status: 'incompatible', gaps: [{ knownMissing: true, requirement: 'professional certification' }],
    })) });
    expect(mismatch.read(PROPOSAL_PATH)).toMatchObject({ status: 'retracted', eligibilityStatus: 'incompatible', retractionReason: 'decisive_requirement_missing', legacyRecoveryStatus: 'terminal' });
  });

  it('does not retract a proposal for an incomplete or unproven incompatibility result', async () => {
    const store = matchingFixture();
    stubJobIndex([matchingJob]);

    const result = await runApplicationConciergeMatching({
      db: store.db,
      serviceId: SERVICE_ID,
      jobIndexUrl: 'https://jobs.example.test/index',
      eligibility: vi.fn(async () => ({ status: 'incompatible', gaps: [{ knownMissing: false, status: 'unknown' }] })),
    });

    expect(result).toMatchObject({ status: 'complete', retracted: 0 });
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'proposed', eligibilityStatus: 'unverified' });
  });

  it.each([
    { name: 'a confirmed missing decisive requirement', job: matchingJob, result: { status: 'incompatible', gaps: [{ knownMissing: true }] }, reason: 'decisive_requirement_missing' },
    { name: 'an explicitly closed listing', job: { ...matchingJob, status: 'closed' }, result: { status: 'compatible' }, reason: 'job_closed' },
  ])('retracts only for $name', async ({ job, result, reason }) => {
    const store = matchingFixture();
    stubJobIndex([job]);

    const outcome = await runApplicationConciergeMatching({
      db: store.db,
      serviceId: SERVICE_ID,
      jobIndexUrl: 'https://jobs.example.test/index',
      eligibility: vi.fn(async () => result),
    });

    expect(outcome).toMatchObject({ status: 'complete', retracted: 1 });
    expect(store.read(PROPOSAL_PATH)).toMatchObject({ status: 'retracted', retractionReason: reason });
  });

  it('adds accepted-role preference to final ranking after the relevance gate', async () => {
    const store = matchingFixture();
    store.docs.set(PROPOSAL_PATH, {
      ...store.read(PROPOSAL_PATH)!,
      status: 'accepted',
      jobTitle: 'IT Application Specialist',
    });
    stubJobIndex([{ id: 'job-2', url: 'https://jobs.example.test/it-application-manager-sap', title: 'IT Application Manager SAP', company: 'Example AG' }]);

    const result = await runApplicationConciergeMatching({
      db: store.db,
      serviceId: SERVICE_ID,
      jobIndexUrl: 'https://jobs.example.test/index',
      eligibility: vi.fn(async () => ({ status: 'compatible' })),
    });

    expect(result).toMatchObject({ status: 'complete', proposals: 1 });
    const proposal = store.list(`${SERVICE_PATH}/proposals/`)
      .map((path) => store.read(path))
      .find((row) => row?.jobId === 'job-2');
    expect(proposal).toMatchObject({ status: 'proposed', jobId: 'job-2' });
    expect(proposal.matchRankingScore - proposal.matchScore).toBe(8);
  });

  it('uses previously accepted role titles as a bounded ordering signal only', () => {
    const job = { title: 'IT Application Manager' };
    expect(approvedRolePreference(job, [{ status: 'accepted', jobTitle: 'IT Application Specialist' }])).toBe(8);
    expect(approvedRolePreference(job, [{ status: 'accepted', withdrawnAt: new Date(), jobTitle: 'IT Application Specialist' }])).toBe(0);
    expect(approvedRolePreference(job, [{ status: 'proposed', jobTitle: 'IT Application Specialist' }])).toBe(0);
  });

  it('keeps decline feedback local to its reason and makes reasonless declines weak', () => {
    const sameRole = { title: 'IT Application Manager', location: 'Lugano', sector: 'technology' };
    const roleDecline = [{ status: 'declined', jobTitle: 'IT Application Specialist', declineReason: 'role' }];
    const reasonlessDecline = [{ status: 'declined', jobTitle: 'IT Application Specialist' }];
    const otherRole = { title: 'Financial Controller', location: 'Lugano', sector: 'technology' };

    expect(rankingFeedbackPreference(sameRole, roleDecline)).toBe(-6);
    expect(rankingFeedbackPreference(sameRole, reasonlessDecline)).toBe(-1);
    expect(rankingFeedbackPreference(otherRole, roleDecline)).toBe(0);
  });

  it('persists ranking features as Firestore-safe arrays and only uses the three latest acceptances', () => {
    const features = rankingFeaturesForJob({ title: 'IT Application Manager', location: 'Lugano' });
    expect(features.role).toContain('application');
    expect(Object.values(features).every(value => Array.isArray(value))).toBe(true);
    const history = [
      { status: 'accepted', jobTitle: 'IT Application Specialist', acceptedAt: new Date(1) },
      { status: 'accepted', jobTitle: 'Financial Controller', acceptedAt: new Date(2) },
      { status: 'accepted', jobTitle: 'Finance Analyst', acceptedAt: new Date(3) },
      { status: 'accepted', jobTitle: 'Accountant', acceptedAt: new Date(4) },
    ];
    expect(approvedRolePreference({ title: 'IT Application Manager' }, history)).toBe(0);
    expect(rankingFeedbackContext(history).accepted).toHaveLength(3);
  });

  it('keeps the open-proposal cap atomic across concurrent triggers and deduplicates a repeated listing', async () => {
    const store = matchingFixture();
    const secondOpenPath = `${SERVICE_PATH}/proposals/proposal-open-2`;
    store.docs.set(secondOpenPath, { status: 'proposed', jobId: 'existing-2', jobUrl: 'https://jobs.example.test/existing-2' });
    store.docs.set(SERVICE_PATH, { ...store.read(SERVICE_PATH)!, matchingOpenProposalCount: 2 });
    serializeTransactions(store);
    const firstJob = { id: 'job-new-1', url: 'https://jobs.example.test/new-1', title: 'IT Manager SAP', company: 'Example AG' };
    const secondJob = { id: 'job-new-2', url: 'https://jobs.example.test/new-2', title: 'IT Manager SAP', company: 'Example AG' };
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      json: async () => String(input).endsWith('/first') ? [firstJob] : [secondJob],
    })));
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));

    await Promise.all([
      runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, jobIndexUrl: 'https://jobs.example.test/first', eligibility }),
      runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, jobIndexUrl: 'https://jobs.example.test/second', eligibility }),
    ]);

    const proposals = store.list(`${SERVICE_PATH}/proposals/`).map(path => store.read(path)!).filter(row => row.status === 'proposed');
    expect(proposals).toHaveLength(APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS);
    expect(new Set(proposals.map(row => row.jobUrl)).size).toBe(APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS);
    expect(store.read(SERVICE_PATH)?.matchingOpenProposalCount).toBe(APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS);
    expect(proposals.filter(row => row.jobId.startsWith('job-new-'))).toHaveLength(1);

    const duplicate = matchingFixture();
    duplicate.docs.delete(PROPOSAL_PATH);
    duplicate.docs.set(SERVICE_PATH, { ...duplicate.read(SERVICE_PATH)!, matchingOpenProposalCount: 0 });
    serializeTransactions(duplicate);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      json: async () => [{ ...matchingJob, id: String(input).endsWith('/first') ? 'provider-id-a' : 'provider-id-b' }],
    })));
    await Promise.all([
      runApplicationConciergeMatching({ db: duplicate.db, serviceId: SERVICE_ID, jobIndexUrl: 'https://jobs.example.test/first', eligibility }),
      runApplicationConciergeMatching({ db: duplicate.db, serviceId: SERVICE_ID, jobIndexUrl: 'https://jobs.example.test/second', eligibility }),
    ]);
    const repeated = duplicate.list(`${SERVICE_PATH}/proposals/`).map(path => duplicate.read(path)!).filter(row => row.status === 'proposed');
    expect(repeated).toHaveLength(1);
    expect(duplicate.read(SERVICE_PATH)?.matchingOpenProposalCount).toBe(1);
  });
});
