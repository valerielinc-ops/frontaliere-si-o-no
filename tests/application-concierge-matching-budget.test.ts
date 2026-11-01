import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ELIGIBILITY_WORK_PER_RUN, runApplicationConciergeMatching } from '../functions/src/applicationConciergeMatching.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const path = 'application_concierge_services/service-budget';
const jobsFor = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `job-${String(index).padStart(3, '0')}`,
  url: `https://jobs.example.test/${String(index).padStart(3, '0')}`,
  title: 'IT Support Manager', description: 'IT support responsibilities',
}));
function fixture({ accepted = 0, maxPositions = 10, proposals = {} } = {} as {
  accepted?: number; maxPositions?: number; proposals?: Record<string, Record<string, unknown>>;
}) {
  return createMemoryFirestore({
    [path]: { userId: 'candidate-budget', paymentStatus: 'paid', serviceStatus: 'active',
      acceptedPositionsCount: accepted, maxPositions, cvStorageKey: 'private/current-cv.pdf',
      expiresAt: new Date(Date.now() + 86_400_000) },
    'user_cv_profiles/candidate-budget': { status: 'ready', profile: {
      searchText: 'IT support', workPosition: 'IT Support Manager', skills: ['IT', 'support'],
    } },
    ...proposals,
  });
}
const listing = (jobs: ReturnType<typeof jobsFor>) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => jobs })));
const proposed = (store: ReturnType<typeof fixture>) => [...store.docs.entries()]
  .filter(([key, value]) => key.startsWith(`${path}/proposals/`) && value.status === 'proposed');
afterEach(() => vi.unstubAllGlobals());

describe('bounded progressive concierge discovery', () => {
  it('finds verified compatible jobs after more than 40 hard mismatches and stops at the target', async () => {
    const store = fixture({ maxPositions: 2 });
    listing(jobsFor(100));
    const eligibility = vi.fn(async (job: { id: string }) => ({ status: job.id < 'job-045' ? 'incompatible' : 'compatible' }));
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(proposed(store).map(([, value]) => value.jobId)).toEqual(['job-045', 'job-046']);
    expect(eligibility).toHaveBeenCalledTimes(47);
    expect(proposed(store).every(([, value]) => value.eligibilityStatus === 'compatible')).toBe(true);
  });

  it('revalidates an already sufficient proposal set without checking or creating fresh jobs', async () => {
    const jobs = jobsFor(20);
    const store = fixture({ maxPositions: 2, proposals: Object.fromEntries(jobs.slice(0, 2).map((job, index) => [
      `${path}/proposals/existing-${index}`, { jobId: job.id, jobUrl: job.url, status: 'proposed' },
    ])) });
    listing(jobs);
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(eligibility).toHaveBeenCalledTimes(2);
    expect(proposed(store)).toHaveLength(2);
    expect(proposed(store).every(([key]) => key.includes('/existing-'))).toBe(true);
  });

  it('persists the frontier at the explicit budget and resumes without losing later jobs', async () => {
    const store = fixture({ maxPositions: 1 });
    const jobs = jobsFor(MAX_ELIGIBILITY_WORK_PER_RUN + 1);
    listing(jobs);
    const eligibility = vi.fn(async (job: { id: string }) => ({ status: job.id === jobs.at(-1)!.id ? 'compatible' : 'incompatible' }));
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(eligibility).toHaveBeenCalledTimes(MAX_ELIGIBILITY_WORK_PER_RUN);
    expect(store.read(path)?.matchingScanCursor).toBe(jobs[MAX_ELIGIBILITY_WORK_PER_RUN - 1].url);
    expect(store.read(path)?.matchingPendingCount).toBe(1);
    expect(proposed(store)).toHaveLength(0);
    eligibility.mockClear();
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(proposed(store).map(([, value]) => value.jobId)).toEqual([jobs.at(-1)!.id]);
    expect(store.read(path)?.matchingPendingCount).toBe(0);
  });

  it('continues past deferred cache misses without advancing the durable cursor past them', async () => {
    const store = fixture({ maxPositions: 1 });
    const jobs = jobsFor(90);
    listing(jobs);
    let newAnalyses = 0;
    const eligibility = vi.fn(async (job: { id: string }) => {
      if (job.id === 'job-055') return { status: 'compatible' }; // Existing verified cache result.
      if (newAnalyses >= 20) return { status: 'unverified', reason: 'analysis_deferred' };
      newAnalyses++;
      return { status: 'incompatible' };
    });
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(newAnalyses).toBe(20);
    expect(eligibility).toHaveBeenCalledTimes(56);
    expect(proposed(store).map(([, value]) => value.jobId)).toEqual(['job-055']);
    expect(store.read(path)?.matchingScanCursor).toBe(jobs[19].url);
    expect(store.read(path)?.matchingPendingCount).toBe(70);
  });

  it('uses only the remaining slot below the ten-application cap and remains idempotent', async () => {
    const store = fixture({ accepted: 9 });
    listing(jobsFor(30));
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(eligibility).toHaveBeenCalledTimes(1);
    await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility });
    expect(eligibility).toHaveBeenCalledTimes(2);
    expect(proposed(store)).toHaveLength(1);
    expect(store.read(path)?.acceptedPositionsCount).toBe(9);
  });

  it('does not fetch or evaluate jobs once ten applications have been accepted', async () => {
    const store = fixture({ accepted: 10 });
    listing(jobsFor(30));
    const eligibility = vi.fn(async () => ({ status: 'compatible' }));
    expect(await runApplicationConciergeMatching({ db: store.db, serviceId: 'service-budget', eligibility }))
      .toEqual({ status: 'skipped', reason: 'position_limit_reached' });
    expect(fetch).not.toHaveBeenCalled();
    expect(eligibility).not.toHaveBeenCalled();
  });
});
