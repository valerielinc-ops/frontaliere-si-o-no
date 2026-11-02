import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { dueEligibilityRetries, eligibilityRetryRef, eligibilityRetrySummary, recordEligibilityRetry } from '../functions/src/applicationConciergeEligibilityRetry.js';
import { conciergeMatchingWork } from '../functions/src/applicationConciergeMatching.js';

const now = Date.now();

function aggregateOnlyEligibilityServiceRef(serviceRef: any) {
  const eligibility = serviceRef.collection('eligibility');
  const query = (source: any, limit: number | null = null) => ({
    where: (field: string, operator: string, value: unknown) => query(source.where(field, operator, value), limit),
    orderBy: (field: string) => query(source.orderBy(field), limit),
    limit: (value: number) => query(source.limit(value), value),
    count: () => source.count(),
    get: () => {
      if (limit === null) throw new Error('unbounded_retry_read');
      return source.get();
    },
  });
  return {
    collection: (name: string) => name === 'eligibility'
      ? { where: (field: string, operator: string, value: unknown) => query(eligibility.where(field, operator, value)) }
      : serviceRef.collection(name),
  };
}

describe('independent qualification retry queue', () => {
  it('retains unknown jobs, backs off, then removes only a verified outcome', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_test');
    const ctx = { db: store.db, serviceRef, url: 'https://jobs.example.test/role', context: 'cv-source-test', nowMs: now };
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified' } });
    expect(await eligibilityRetrySummary(serviceRef)).toEqual({
      count: 1, retryAt: now + 3600000, statusCounts: { unverified: 1 }, reasonCounts: { unknown: 1 },
    });
    expect((await eligibilityRetryRef(serviceRef, ctx.url).get()).data()).toMatchObject({
      lastStatus: 'unverified', lastReason: 'unknown', lastAttemptAt: now,
    });
    expect(await dueEligibilityRetries(serviceRef, now)).toHaveLength(0);
    expect(await dueEligibilityRetries(serviceRef, now + 3600000)).toHaveLength(1);
    await recordEligibilityRetry({ ...ctx, nowMs: now + 3600000, result: { status: 'unverified' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000);
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'analysis_deferred' } });
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'retry_backoff' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000);
    expect((await eligibilityRetryRef(serviceRef, ctx.url).get()).data()).toMatchObject({
      attempts: 2, lastStatus: 'unverified', lastReason: 'retry_backoff', lastAttemptAt: now,
    });
    await recordEligibilityRetry({ ...ctx, result: { status: 'invalid_response' } });
    expect((await eligibilityRetrySummary(serviceRef)).count).toBe(1);
    await recordEligibilityRetry({ ...ctx, result: { status: 'clarification_required' } });
    expect(await eligibilityRetrySummary(serviceRef)).toEqual({ count: 0, retryAt: null, statusCounts: {}, reasonCounts: {} });
    expect(eligibilityRetryRef(serviceRef, ctx.url).path).toMatch(/\/eligibility\/retry-[a-f0-9]{32}$/);
  });

  it.each(['compatible', 'incompatible', 'clarification_required'])('removes retry state after %s', async status => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc(`service_${status}`);
    const ctx = { db: store.db, serviceRef, url: `https://jobs.example.test/${status}`, context: 'current-context', nowMs: now };
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'posting_incomplete' } });
    await recordEligibilityRetry({ ...ctx, result: { status } });

    expect((await eligibilityRetryRef(serviceRef, ctx.url).get()).exists).toBe(false);
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({ count: 0, statusCounts: {}, reasonCounts: {} });
  });

  it('leaves first-time deferred work on the scan frontier without creating a retry row', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_first_deferred');
    const url = 'https://jobs.example.test/first-deferred';
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'current-context', nowMs: now,
      result: { status: 'unverified', reason: 'analysis_deferred' } });

    expect((await eligibilityRetryRef(serviceRef, url).get()).exists).toBe(false);
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({ count: 0, statusCounts: {}, reasonCounts: {} });
  });

  it('counts recognized evidence-refresh reasons while preserving the unknown fallback', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_evidence_refresh');
    const url = 'https://jobs.example.test/evidence-refresh';
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'current-context', nowMs: now,
      result: { status: 'unverified', reason: 'evidence_source_changed' } });

    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      statusCounts: { unverified: 1 }, reasonCounts: { evidence_source_changed: 1 },
    });
  });

  it('summarizes a response-sized queue with aggregates and a bounded earliest-retry read', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_large_queue');
    const eligibility = serviceRef.collection('eligibility');
    const oversizedLegacyPayload = 'x'.repeat(50_000);
    const rows = 220;
    for (let index = 0; index < rows; index += 1) {
      await eligibility.doc(`retry-${String(index).padStart(3, '0')}`).set({
        jobUrl: `https://jobs.example.test/large-${index}`,
        context: oversizedLegacyPayload,
        attempts: 1,
        retryAt: now + index + 1,
        oversizedLegacyField: oversizedLegacyPayload,
        ...(index % 3 !== 0 ? { lastStatus: 'unverified' } : {}),
        ...(index % 2 === 0 ? { lastReason: 'posting_incomplete' } : {}),
      });
    }

    expect(await eligibilityRetrySummary(aggregateOnlyEligibilityServiceRef(serviceRef))).toEqual({
      count: rows,
      retryAt: now + 1,
      statusCounts: { unverified: 146, unknown: 74 },
      reasonCounts: { posting_incomplete: 110, unknown: 110 },
    });
  });

  it('resets attempts for stale context and records only allowlisted status and reason values', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_stale_context');
    const url = 'https://jobs.example.test/stale-context';
    const first = { db: store.db, serviceRef, url, context: 'old-context', nowMs: now };
    await recordEligibilityRetry({ ...first, result: { status: 'unverified', reason: 'analysis_unavailable' } });
    await recordEligibilityRetry({ ...first, context: 'new-context', nowMs: now + 10_000, result: {
      status: 'untrusted_status',
      reason: 'raw provider error text must never persist',
    } });

    const retry = (await eligibilityRetryRef(serviceRef, url).get()).data();
    expect(retry).toMatchObject({
      context: 'new-context', attempts: 1, retryAt: now + 10_000 + 3600000,
      lastStatus: 'unknown', lastReason: 'unknown', lastAttemptAt: now + 10_000,
    });
    expect(JSON.stringify(retry)).not.toContain('raw provider error text must never persist');
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, statusCounts: { unknown: 1 }, reasonCounts: { unknown: 1 },
    });
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

  it('keeps bounded provider diagnostics and excludes raw error details', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_diagnostics');
    const url = 'https://jobs.example.test/diagnostic-role';
    await recordEligibilityRetry({
      db: store.db,
      serviceRef,
      url,
      context: 'diagnostic-context',
      nowMs: now,
      result: {
        status: 'unverified',
        providerFailures: [
          { provider: 'gemini', cause: 'rate_limited', status: 429 },
          { provider: 'nvidia-gpt-oss-20b', cause: 'timeout', status: null, detail: 'prompt must never persist' },
          { provider: 'ignored', cause: 'invented', status: 200 },
        ],
      },
    });

    const retry = (await eligibilityRetryRef(serviceRef, url).get()).data();
    expect(retry.providerFailures).toEqual([
      { provider: 'gemini', cause: 'rate_limited', status: 429 },
      { provider: 'nvidia-gpt-oss-20b', cause: 'timeout', status: null },
    ]);
    expect(JSON.stringify(retry)).not.toContain('prompt must never persist');
    await recordEligibilityRetry({
      db: store.db, serviceRef, url, context: 'diagnostic-context', nowMs: now + 1,
      result: { status: 'unverified', reason: 'posting_incomplete' },
    });
    expect((await eligibilityRetryRef(serviceRef, url).get()).data()?.providerFailures).toEqual(retry.providerFailures);
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      statusCounts: { unverified: 1 }, reasonCounts: { posting_incomplete: 1 },
    });
  });

  it('prioritizes the bounded legacy recovery batch and keeps backoff rows out of fresh work', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({ url: `job-${index}` }));
    const result = conciergeMatchingWork(candidates, new Set(), '', new Set(), ['job-80', 'job-81'], new Set(['job-80', 'job-81', 'job-82']));
    expect(result.work.slice(0, 2).map((row: any) => row.url)).toEqual(['job-80', 'job-81']);
    expect(result.work[2].url).toBe('job-0');
    expect(result.work.some((row: any) => row.url === 'job-82')).toBe(false);
    expect(result.frontier.some((row: any) => row.url === 'job-82')).toBe(false);
    expect(result.work).toHaveLength(40);
  });
});
