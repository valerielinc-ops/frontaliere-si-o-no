import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS } from '../functions/src/applicationConciergeConstants.js';
import { eligibilityRetryRef } from '../functions/src/applicationConciergeEligibilityRetry.js';
import { LEGACY_UNVERIFIED_RETRACTION_REASON } from '../functions/src/applicationConciergeProposalRecovery.js';
import { conciergeRefreshDue } from '../functions/src/applicationConciergeLifecyclePolicy.js';

vi.mock('firebase-admin/firestore', () => {
  class DeleteTransform {}
  return {
    DeleteTransform,
    FieldValue: {
      serverTimestamp: () => '__server_timestamp__',
      increment: (value: number) => ({ __increment: value }),
      delete: () => new DeleteTransform(),
    },
    Timestamp: { now: () => new Date() },
  };
});
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: vi.fn() }));
vi.mock('../functions/src/applicationConciergeEligibility.js', () => ({
  CONCIERGE_ELIGIBILITY_VERSION: 'test-eligibility-v1',
  CONCIERGE_ELIGIBILITY_UNRESOLVED_STATUS: 'unresolved',
  CONCIERGE_ELIGIBILITY_UNRESOLVED_REASON: 'eligibility_unresolved',
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

const { PROPOSAL_STALL_GRACE_MS, eligibilityRetryContext, proposalStall, runApplicationConciergeMatching } =
  await import('../functions/src/applicationConciergeMatching.js');

const SERVICE_ID = 'service-1';
const SERVICE_PATH = `application_concierge_services/${SERVICE_ID}`;
const CV_KEY = `application-concierge-uploads/${SERVICE_ID}/cv.pdf`;
const PROFILE = { searchText: 'IT Manager SAP', workPosition: 'IT Manager', skills: ['SAP'] };
const openPath = (index: number) => `${SERVICE_PATH}/proposals/open-${index}`;
const openUrl = (index: number) => `https://jobs.example.test/open-${index}`;
const freshJob = { id: 'job-fresh', url: 'https://jobs.example.test/fresh', title: 'IT Manager SAP', company: 'Example AG' };

function fullQuotaFixture() {
  const docs: Record<string, Record<string, unknown>> = {
    [SERVICE_PATH]: {
      userId: 'candidate-1',
      paymentStatus: 'paid',
      serviceStatus: 'active',
      expiresAt: new Date(Date.now() + 10 * 86400000),
      cvStorageKey: CV_KEY,
      maxPositions: 10,
      acceptedPositionsCount: 0,
      matchingStatus: 'complete',
      matchingOpenProposalCount: APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS,
    },
    'user_cv_profiles/candidate-1': { status: 'ready', profile: PROFILE },
  };
  for (let index = 1; index <= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS; index += 1) {
    docs[openPath(index)] = {
      jobId: `open-${index}`,
      jobUrl: openUrl(index),
      companyName: 'Example AG',
      jobTitle: 'IT Manager SAP',
      status: 'proposed',
      eligibilityStatus: 'unverified',
      eligibilityVersion: 'test-eligibility-v1',
      eligibilityCvStorageKey: CV_KEY,
      matchScore: 72,
    };
  }
  return createMemoryFirestore(docs);
}

function stubJobIndex(jobs: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => jobs })));
}

const openRows = (store: ReturnType<typeof createMemoryFirestore>) => store.list(`${SERVICE_PATH}/proposals/`)
  .map(path => store.read(path)!).filter(row => row.status === 'proposed');

function ageStall(store: ReturnType<typeof createMemoryFirestore>, path: string, ageMs: number) {
  store.docs.set(path, { ...store.read(path)!, eligibilityStalledAt: new Date(Date.now() - ageMs) });
}

afterEach(() => vi.unstubAllGlobals());

describe('stalled concierge proposals release their open slot', () => {
  it('holds an omitted listing for the grace, then retracts it as uncertain and publishes a verified job', async () => {
    const store = fullQuotaFixture();
    stubJobIndex([freshJob]);
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));

    const first = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(first).toMatchObject({ status: 'complete', proposals: 0, retracted: 0 });
    for (let index = 1; index <= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS; index += 1) {
      expect(store.read(openPath(index))).toMatchObject({ status: 'proposed', eligibilityStatus: 'unverified',
        eligibilityStallReason: 'listing_not_ranked', eligibilityStalledAt: expect.any(Date) });
    }
    const releaseAt = Number(store.read(SERVICE_PATH)?.matchingStallReleaseAt);
    expect(releaseAt).toBeGreaterThan(Date.now() + PROPOSAL_STALL_GRACE_MS - 60_000);
    const consented = { ...store.read(SERVICE_PATH), consentedAt: new Date() };
    expect(conciergeRefreshDue(consented, Date.now())).toBe(false);
    expect(conciergeRefreshDue(consented, releaseAt)).toBe(true);

    // Inside the grace nothing is released, and the first stall time is kept.
    const markedAt = (store.read(openPath(1))!.eligibilityStalledAt as Date).getTime();
    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(openRows(store)).toHaveLength(APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS);
    expect((store.read(openPath(1))!.eligibilityStalledAt as Date).getTime()).toBe(markedAt);

    for (let index = 1; index <= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS; index += 1) {
      ageStall(store, openPath(index), PROPOSAL_STALL_GRACE_MS + 60_000);
    }
    const released = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });

    expect(released).toMatchObject({ status: 'complete', retracted: APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS, proposals: 1 });
    for (let index = 1; index <= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS; index += 1) {
      expect(store.read(openPath(index))).toMatchObject({
        status: 'retracted',
        eligibilityStatus: 'unverified',
        retractionReason: LEGACY_UNVERIFIED_RETRACTION_REASON,
        legacyRecoveryStatus: 'pending',
      });
    }
    expect(openRows(store).map(row => row.jobUrl)).toEqual([freshJob.url]);
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingOpenProposalCount: 1, matchingStallReleaseAt: null });

    // The released rows stay in the bounded legacy recovery, never terminal for an absent listing.
    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    const recovered = store.read(openPath(1))!;
    expect(recovered).toMatchObject({ status: 'retracted', legacyRecoveryStatus: 'pending', legacyRecoveryLastReason: 'listing_not_in_current_index' });
    expect(Number(recovered.legacyRecoveryNextAt)).toBeGreaterThan(Date.now());
  });

  it('releases a ranked listing whose eligibility retries are exhausted', async () => {
    const store = fullQuotaFixture();
    const job = { id: 'open-1', url: openUrl(1), title: 'IT Manager SAP', company: 'Example AG' };
    stubJobIndex([job]);
    const scanContext = createHash('sha256').update(JSON.stringify(['test-eligibility-v1', CV_KEY, PROFILE])).digest('hex');
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    await eligibilityRetryRef(serviceRef, job.url).set({
      jobUrl: job.url,
      context: eligibilityRetryContext(scanContext, { ...job, location: '' }, 'a'.repeat(64)),
      jobContext: eligibilityRetryContext(scanContext, { ...job, location: '' }),
      fingerprint: 'a'.repeat(64),
      attempts: 5,
      retryAt: 0,
      retryState: 'exhausted',
      lastStatus: 'unverified',
      lastReason: 'provider_invalid_json',
      firstAttemptAt: Date.now() - 5 * 86400000,
      lastAttemptAt: Date.now(),
    });
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(eligibility).not.toHaveBeenCalled();
    expect(store.read(openPath(1))).toMatchObject({ status: 'proposed', eligibilityStallReason: 'eligibility_retry_exhausted' });

    ageStall(store, openPath(1), PROPOSAL_STALL_GRACE_MS + 60_000);
    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(store.read(openPath(1))).toMatchObject({ status: 'retracted', retractionReason: LEGACY_UNVERIFIED_RETRACTION_REASON });
  });

  it('never stalls a listing whose retry is only scheduled, and clears an earlier stall', async () => {
    const store = fullQuotaFixture();
    const job = { id: 'open-1', url: openUrl(1), title: 'IT Manager SAP', company: 'Example AG' };
    stubJobIndex([job]);
    ageStall(store, openPath(1), PROPOSAL_STALL_GRACE_MS + 60_000);
    store.docs.set(openPath(1), { ...store.read(openPath(1))!, eligibilityStallReason: 'listing_not_ranked' });
    const scanContext = createHash('sha256').update(JSON.stringify(['test-eligibility-v1', CV_KEY, PROFILE])).digest('hex');
    const serviceRef = store.db.collection('application_concierge_services').doc(SERVICE_ID);
    await eligibilityRetryRef(serviceRef, job.url).set({
      jobUrl: job.url,
      context: eligibilityRetryContext(scanContext, { ...job, location: '' }),
      jobContext: eligibilityRetryContext(scanContext, { ...job, location: '' }),
      attempts: 3,
      retryAt: Date.now() + 3600_000,
      retryState: 'scheduled',
      lastStatus: 'unverified',
      lastReason: 'provider_invalid_json',
      firstAttemptAt: Date.now() - 86400000,
      lastAttemptAt: Date.now(),
    });
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));

    const result = await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(result).toMatchObject({ retracted: 0 });
    expect(eligibility).not.toHaveBeenCalled();
    expect(store.read(openPath(1))).toMatchObject({ status: 'proposed', eligibilityStalledAt: null, eligibilityStallReason: null });
  });

  it('clears the stall when the listing verifies again', async () => {
    const store = fullQuotaFixture();
    const job = { id: 'open-1', url: openUrl(1), title: 'IT Manager SAP', company: 'Example AG' };
    stubJobIndex([job]);
    ageStall(store, openPath(1), 60_000);
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));

    await runApplicationConciergeMatching({ db: store.db, serviceId: SERVICE_ID, eligibility });
    expect(store.read(openPath(1))).toMatchObject({ status: 'proposed', eligibilityStatus: 'compatible', eligibilityStalledAt: null });
  });

  it('names a stall only for states the retry queue no longer owns', () => {
    const nowMs = Date.parse('2026-11-10T12:00:00Z');
    expect(proposalStall({ result: { status: 'unverified', reason: 'retry_backoff' }, nowMs })).toMatchObject({ release: false, fields: {} });
    expect(proposalStall({ result: { status: 'unverified', reason: 'analysis_deferred' }, nowMs })).toMatchObject({ release: false, fields: {} });
    expect(proposalStall({ ranked: false, nowMs })).toMatchObject({ release: false, releaseAt: nowMs + PROPOSAL_STALL_GRACE_MS,
      fields: { eligibilityStallReason: 'listing_not_ranked' } });
    expect(proposalStall({ belowThreshold: true, nowMs })).toMatchObject({ fields: { eligibilityStallReason: 'match_below_threshold' } });
    expect(proposalStall({ data: { eligibilityStalledAt: nowMs - PROPOSAL_STALL_GRACE_MS }, result: { retryExhausted: true }, nowMs }))
      .toMatchObject({ release: true, fields: { eligibilityStallReason: 'eligibility_retry_exhausted' } });
  });
});
