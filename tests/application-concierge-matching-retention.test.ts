import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

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

const { approvedRolePreference, runApplicationConciergeMatching } = await import('../functions/src/applicationConciergeMatching.js');

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

function stubJobIndex(jobs: unknown[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => jobs }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const matchingJob = { id: 'job-1', url: JOB_URL, title: 'IT Manager SAP', company: 'Example AG' };

afterEach(() => vi.unstubAllGlobals());

describe('application concierge proposal retention', () => {
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
});
