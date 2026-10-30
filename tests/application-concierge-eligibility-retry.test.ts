import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { dueEligibilityRetries, eligibilityRetryRef, eligibilityRetrySummary, recordEligibilityRetry } from '../functions/src/applicationConciergeEligibilityRetry.js';
import { conciergeMatchingWork } from '../functions/src/applicationConciergeMatching.js';

const now = Date.now();
describe('independent qualification retry queue', () => {
  it('retains unknown jobs, backs off, then removes only a verified outcome', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_test');
    const ctx = { db: store.db, serviceRef, url: 'https://jobs.example.test/role', context: 'cv-source-test', nowMs: now };
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified' } });
    expect(await eligibilityRetrySummary(serviceRef)).toEqual({ count: 1, retryAt: now + 3600000 });
    expect(await dueEligibilityRetries(serviceRef, now)).toHaveLength(0);
    expect(await dueEligibilityRetries(serviceRef, now + 3600000)).toHaveLength(1);
    await recordEligibilityRetry({ ...ctx, nowMs: now + 3600000, result: { status: 'unverified' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000);
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'analysis_deferred' } });
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'retry_backoff' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000);
    await recordEligibilityRetry({ ...ctx, result: { status: 'invalid_response' } });
    expect((await eligibilityRetrySummary(serviceRef)).count).toBe(1);
    await recordEligibilityRetry({ ...ctx, result: { status: 'clarification_required' } });
    expect(await eligibilityRetrySummary(serviceRef)).toEqual({ count: 0, retryAt: null });
    expect(eligibilityRetryRef(serviceRef, ctx.url).path).toMatch(/\/eligibility\/retry-[a-f0-9]{32}$/);
  });

  it('reserves space for new discovery when many retries and proposals exist', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({ url: `job-${index}` }));
    const proposed = new Set(candidates.slice(0, 30).map(row => row.url));
    const retry = new Set(candidates.slice(30, 70).map(row => row.url));
    const result = conciergeMatchingWork(candidates, proposed, '', retry);
    expect(result.work).toHaveLength(40);
    expect(result.work.filter((row: any) => proposed.has(row.url))).toHaveLength(10);
    expect(result.work.filter((row: any) => retry.has(row.url))).toHaveLength(8);
    expect(result.work.some((row: any) => row.url === 'job-70')).toBe(true);
  });
});
