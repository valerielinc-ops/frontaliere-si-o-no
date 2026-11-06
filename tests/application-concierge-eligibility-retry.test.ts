import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS } from '../functions/src/applicationConciergeConstants.js';
import { dueEligibilityRetries, eligibilityRetryRef, eligibilityRetryRows, eligibilityRetrySummary,
  ELIGIBILITY_RETRY_REASON_PROVENANCE, MAX_ELIGIBILITY_DEFERRALS, MAX_ELIGIBILITY_RETRY_ATTEMPTS, recordEligibilityRetry } from '../functions/src/applicationConciergeEligibilityRetry.js';
import { conciergeMatchingWork, eligibilityRetryContext } from '../functions/src/applicationConciergeMatching.js';

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
    get: () => serviceRef.get(),
    collection: (name: string) => name === 'eligibility'
      ? { where: (field: string, operator: string, value: unknown) => query(eligibility.where(field, operator, value)) }
      : serviceRef.collection(name),
  };
}

describe('independent qualification retry queue', () => {
  it('classifies every persisted retry reason and keeps the removed requirements emitter explicitly legacy', () => {
    for (const [reason, provenance] of Object.entries(ELIGIBILITY_RETRY_REASON_PROVENANCE)) {
      expect(provenance).toMatch(/^(?:current:[A-Za-z][A-Za-z0-9]+|legacy(?::.*)?|internal:.*)$/);
      if (provenance.startsWith('current:')) {
        const producer = provenance.slice('current:'.length);
        expect(readFileSync(new URL(`../functions/src/${producer}.js`, import.meta.url), 'utf8')).toContain(reason);
      }
    }
    expect(ELIGIBILITY_RETRY_REASON_PROVENANCE.requirements_incomplete).toMatch(/^legacy:/);
    expect(ELIGIBILITY_RETRY_REASON_PROVENANCE.clarification_questions_missing).toBe('current:applicationConciergeEligibility');
    expect(Object.keys(ELIGIBILITY_RETRY_REASON_PROVENANCE)).toContain('retry_backoff');
  });

  it('retains unknown jobs, backs off, then removes only a verified outcome', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_test');
    const ctx = { db: store.db, serviceRef, url: 'https://jobs.example.test/role', context: 'cv-source-test', nowMs: now };
    await recordEligibilityRetry({ ...ctx, result: { status: 'unverified', reason: 'posting_unavailable' } });
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, retryCount: 1, exhaustedCount: 0, retryAt: now + 3600000,
      statusCounts: { unverified: 1 }, reasonCounts: { posting_unavailable: 1 },
      recovery: { count: 0, averageDurationMs: null, lastDurationMs: null, lastStatus: null, lastAt: null },
    });
    expect((await eligibilityRetryRef(serviceRef, ctx.url).get()).data()).toMatchObject({
      lastStatus: 'unverified', lastReason: 'posting_unavailable', lastAttemptAt: now,
    });
    expect(await dueEligibilityRetries(serviceRef, now)).toHaveLength(0);
    expect(await dueEligibilityRetries(serviceRef, now + 3600000)).toHaveLength(1);
    await recordEligibilityRetry({ ...ctx, nowMs: now + 3600000, result: { status: 'unverified', reason: 'hard_requirement_uncovered' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000);
    await recordEligibilityRetry({ ...ctx, nowMs: now + 4 * 3600000, result: { status: 'unverified', reason: 'analysis_deferred' } });
    await recordEligibilityRetry({ ...ctx, nowMs: now + 4 * 3600000 + 1, result: { status: 'unverified', reason: 'retry_backoff' } });
    expect((await eligibilityRetrySummary(serviceRef)).retryAt).toBe(now + 4 * 3600000 + 15 * 60_000);
    expect((await eligibilityRetryRef(serviceRef, ctx.url).get()).data()).toMatchObject({
      attempts: 2, lastStatus: 'unverified', lastReason: 'hard_requirement_uncovered', lastAttemptAt: now + 3600000,
    });
    await recordEligibilityRetry({ ...ctx, nowMs: now + 4 * 3600000 + 16 * 60_000, result: { status: 'invalid_response' } });
    expect((await eligibilityRetrySummary(serviceRef)).count).toBe(1);
    await recordEligibilityRetry({ ...ctx, nowMs: now + 4 * 3600000 + 17 * 60_000, result: { status: 'clarification_required' } });
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({ count: 0, retryCount: 0, exhaustedCount: 0,
      retryAt: null, statusCounts: {}, reasonCounts: {}, recovery: { count: 1, lastStatus: 'clarification_required' } });
    expect((await eligibilityRetrySummary(serviceRef)).recovery.lastDurationMs).toBe(4 * 3600000 + 17 * 60_000);
    expect(eligibilityRetryRef(serviceRef, ctx.url).path).toMatch(/\/eligibility\/retry-[a-f0-9]{32}$/);
  });

  it('preserves retry source and candidate-fact dependencies when a refresh cannot fetch the posting', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_fetch_failure');
    const url = 'https://jobs.example.test/fetch-failure';
    const ref = eligibilityRetryRef(serviceRef, url);
    const sourceFingerprint = 'a'.repeat(64);
    await ref.set({
      jobUrl: url,
      context: 'eligibility-context-1',
      jobContext: 'eligibility-job-context-1',
      retryBudgetContext: 'stable-budget-source-context',
      retryBudgetJobContext: 'stable-budget-job-context',
      sourceFingerprint,
      candidateFactsDependency: { languages: true, answers: false },
      eligibilityFactsRevision: 1,
      attempts: 5,
      deferrals: 0,
      retryAt: 0,
      retryState: 'exhausted',
      lastStatus: 'unverified',
      lastReason: 'provider_unavailable',
    });

    await recordEligibilityRetry({
      db: store.db,
      serviceRef,
      url,
      context: 'eligibility-context-2',
      jobContext: 'eligibility-job-context-2',
      budgetContext: 'stable-budget-source-context',
      budgetJobContext: 'stable-budget-job-context',
      eligibilityFactsRevision: 2,
      nowMs: now + 60_000,
      result: { status: 'unverified', reason: 'posting_unavailable' },
    });

    expect((await ref.get()).data()).toMatchObject({
      context: 'eligibility-context-2',
      jobContext: 'eligibility-job-context-2',
      retryBudgetContext: 'stable-budget-source-context',
      retryBudgetJobContext: 'stable-budget-job-context',
      sourceFingerprint,
      candidateFactsDependency: { languages: true, answers: false },
      eligibilityFactsRevision: 2,
      attempts: 5,
      retryState: 'exhausted',
    });
  });

  it('does not reset a legacy retry budget when the posting source is temporarily unavailable', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_legacy_fetch_failure');
    const url = 'https://jobs.example.test/legacy-fetch-failure';
    const ref = eligibilityRetryRef(serviceRef, url);
    await ref.set({
      jobUrl: url,
      context: 'legacy-source-context',
      jobContext: 'stable-job-context',
      candidateFactsDependency: { languages: true, answers: false },
      eligibilityFactsRevision: 1,
      attempts: 5,
      deferrals: 0,
      retryAt: 0,
      retryState: 'exhausted',
      lastStatus: 'unverified',
      lastReason: 'provider_unavailable',
    });

    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'new-source-context',
      jobContext: 'stable-job-context', eligibilityFactsRevision: 2, nowMs: now + 60_000,
      result: { status: 'unverified', reason: 'posting_unavailable' } });

    expect((await ref.get()).data()).toMatchObject({
      context: 'new-source-context',
      jobContext: 'stable-job-context',
      candidateFactsDependency: { languages: true, answers: false },
      eligibilityFactsRevision: 2,
      attempts: 5,
      retryState: 'exhausted',
    });
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

  it('schedules first-time deferred work with a bounded next check', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_first_deferred');
    const url = 'https://jobs.example.test/first-deferred';
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'current-context', nowMs: now,
      result: { status: 'unverified', reason: 'analysis_deferred' } });

    expect((await eligibilityRetryRef(serviceRef, url).get()).data()).toMatchObject({
      attempts: 0, deferrals: 1, retryState: 'deferred', retryAt: now + 15 * 60_000, lastReason: 'analysis_deferred',
    });
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, retryCount: 1, exhaustedCount: 0, statusCounts: { unverified: 1 }, reasonCounts: { analysis_deferred: 1 },
    });
  });

  it('exhausts repeatedly deferred work with a capped exponential delay', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_deferred_exhausted');
    const url = 'https://jobs.example.test/deferred';
    let at = now;
    for (let deferral = 0; deferral < MAX_ELIGIBILITY_DEFERRALS; deferral += 1) {
      await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'same-inputs', nowMs: at,
        result: { status: 'unverified', reason: 'analysis_deferred' } });
      at += 15 * 60_000 * (2 ** deferral);
    }
    expect((await eligibilityRetryRef(serviceRef, url).get()).data()).toMatchObject({
      attempts: 0, deferrals: MAX_ELIGIBILITY_DEFERRALS, retryState: 'exhausted', retryAt: 0, lastReason: 'analysis_deferred',
    });
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'same-inputs', nowMs: at,
      result: { status: 'unverified', reason: 'analysis_deferred' } });
    expect((await eligibilityRetryRef(serviceRef, url).get()).data().deferrals).toBe(MAX_ELIGIBILITY_DEFERRALS);
  });

  it('counts recognized evidence-refresh reasons while preserving the unknown fallback', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_evidence_refresh');
    const url = 'https://jobs.example.test/evidence-refresh';
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'current-context', nowMs: now,
      result: { status: 'unverified', reason: 'evidence_source_changed' } });

    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, retryCount: 1, exhaustedCount: 0,
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

    expect(await eligibilityRetrySummary(aggregateOnlyEligibilityServiceRef(serviceRef))).toMatchObject({
      count: rows, retryCount: rows, exhaustedCount: 0,
      retryAt: now + 1,
      statusCounts: { unverified: 146, unknown: 74 },
      reasonCounts: { posting_incomplete: 110, unknown: 110 },
      recovery: { count: 0, averageDurationMs: null, lastDurationMs: null, lastStatus: null, lastAt: null },
    });
  });

  it('resets attempts for stale context and records only allowlisted status and reason values', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_stale_context');
    const url = 'https://jobs.example.test/stale-context';
    const first = { db: store.db, serviceRef, url, context: 'old-context', nowMs: now };
    await recordEligibilityRetry({ ...first, result: { status: 'unverified', reason: 'analysis_unavailable',
      providerFailures: [{ provider: 'gemini', cause: 'timeout', status: null }] } });
    await recordEligibilityRetry({ ...first, context: 'new-context', nowMs: now + 10_000, result: {
      status: 'untrusted_status',
      reason: 'raw provider error text must never persist',
    } });

    const retry = (await eligibilityRetryRef(serviceRef, url).get()).data();
    expect(retry).toMatchObject({
      context: 'new-context', attempts: 1, retryAt: now + 10_000 + 3600000,
      lastStatus: 'unknown', lastReason: 'unknown', lastAttemptAt: now + 10_000,
    });
    expect(retry).not.toHaveProperty('providerFailures');
    expect(JSON.stringify(retry)).not.toContain('raw provider error text must never persist');
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, retryCount: 1, exhaustedCount: 0,
      statusCounts: { unknown: 1 }, reasonCounts: { unknown: 1 },
    });
  });

  it('exhausts retries after the fixed attempt budget and does not revive an unchanged row', async () => {
    const store = createMemoryFirestore();
    const serviceRef = store.db.collection('application_concierge_services').doc('service_exhausted');
    const url = 'https://jobs.example.test/exhausted';
    for (let attempt = 0; attempt < MAX_ELIGIBILITY_RETRY_ATTEMPTS; attempt += 1) {
      await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'stable-inputs', nowMs: now + attempt * 4 * 86400_000,
        result: { status: 'unverified', reason: 'posting_unavailable' } });
    }
    const ref = eligibilityRetryRef(serviceRef, url);
    expect((await ref.get()).data()).toMatchObject({
      attempts: MAX_ELIGIBILITY_RETRY_ATTEMPTS, retryAt: 0, retryState: 'exhausted', lastReason: 'posting_unavailable',
    });
    expect(await dueEligibilityRetries(serviceRef, now + 100 * 86400_000)).toHaveLength(0);
    expect(await eligibilityRetryRows(serviceRef)).toHaveLength(1);
    expect(await eligibilityRetrySummary(serviceRef)).toMatchObject({
      count: 1, retryCount: 0, exhaustedCount: 1, retryAt: null,
      statusCounts: { unverified: 1 }, reasonCounts: { posting_unavailable: 1 },
    });

    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'stable-inputs', nowMs: now + 101 * 86400_000,
      result: { status: 'unverified', reason: 'posting_unavailable' } });
    expect((await ref.get()).data().attempts).toBe(MAX_ELIGIBILITY_RETRY_ATTEMPTS);
    await recordEligibilityRetry({ db: store.db, serviceRef, url, context: 'changed-primary-source', nowMs: now + 102 * 86400_000,
      result: { status: 'unverified', reason: 'posting_incomplete' } });
    expect((await ref.get()).data()).toMatchObject({ attempts: 1, retryState: 'scheduled', lastReason: 'posting_incomplete' });
  });

  it('reserves space for new discovery when many retries and proposals exist', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({ url: `job-${index}` }));
    const proposed = new Set(candidates.slice(0, 30).map(row => row.url));
    const retry = new Set(candidates.slice(30, 70).map(row => row.url));
    const result = conciergeMatchingWork(candidates, proposed, '', retry);
    expect(result.work).toHaveLength(40);
    expect(result.work.filter((row: any) => proposed.has(row.url))).toHaveLength(APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS);
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

  it('holds exhausted and future retry rows out of fresh discovery until due', () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({ url: `job-${index}` }));
    const held = new Set(['job-0', 'job-1', 'job-2']);
    const result = conciergeMatchingWork(candidates, new Set(), '', new Set(), [], new Set(), held);
    expect(result.work.some((row: any) => held.has(row.url))).toBe(false);
    expect(result.cursorUrls.has('job-0')).toBe(false);
    expect(result.work).toHaveLength(40);
  });

  it('resets retry identity when candidate or indexed primary-source metadata changes', () => {
    const job = { id: 'job-a', title: 'Analyst', company: 'Example AG', location: 'Lugano',
      description: 'Role description A', dateModified: '2026-11-01' };
    const original = eligibilityRetryContext('candidate-profile-context', job);
    expect(eligibilityRetryContext('candidate-profile-context', { ...job })).toBe(original);
    expect(eligibilityRetryContext('changed-candidate-profile-context', job)).not.toBe(original);
    expect(eligibilityRetryContext('candidate-profile-context', { ...job, description: 'Role description B' })).not.toBe(original);
    expect(eligibilityRetryContext('candidate-profile-context', { ...job, dateModified: '2026-11-02' })).not.toBe(original);
    expect(eligibilityRetryContext('candidate-profile-context', job, 'a'.repeat(64)))
      .not.toBe(eligibilityRetryContext('candidate-profile-context', job, 'b'.repeat(64)));
  });
});
