import { describe, expect, it } from 'vitest';
import { jobCanonV2ShardKey as workerJobCanonV2ShardKey } from '../infra/cloudflare-worker/locale-router.js';
import {
  buildIssueBody,
  buildBlockedUaFilters,
  buildOriginFailureLogFilters,
  estimateMonthlyLogVolume,
  evaluateChecks,
  estimateFallbackMissProbability,
  evaluateJobCanonParity,
  JOB_CANON_MAX_SAMPLE_INTERVAL,
  JOB_CANON_WINDOW_LADDER_MS,
  collectJobCanonDailyWindows,
  jobCanonV2ShardKey,
  evaluateJobCanonV1Retirement,
  isCloudflareFullSamplingInterval,
  isOriginFailureLogEvent,
  isReportOnly,
  issueTitle,
} from '../scripts/cf-observability-audit.mjs';

const healthy = {
  total: 1_000_000,
  count503: 10,
  max503PerBucket: 5,
  count404: 20_000,
  originFailureLogs: 10,
  internalCrawlerRequests: 100_000,
  versionRequests: 10_000,
  blockedRequests: { Baiduspider: 0, CorsairBot: 0 },
  topUserAgents: [{ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', count: 300_000 }],
  googlebotTotal: 300_000,
  googlebot301: 3_000,
  avgEventBytes: 5_900,
  samplingRate: 0.1,
  redactQueryString: true,
};
const before = new Date('2026-11-15T00:00:00Z');
const failing = (snapshot: typeof healthy, now = before) =>
  evaluateChecks(snapshot, now).filter((check) => check.failed).map((check) => check.id);

const retirementDays = Array.from({ length: 7 }, (_, index) => `2026-11-${String(20 + index).padStart(2, '0')}`);
// Real Workers Logs shape: query-side sampling interval 10 on every day.
const completeJobCanonRetirementSnapshot = () => ({
  queryWindowDays: 7,
  jobCanonV2Daily: retirementDays.map((day) => ({ day, count: 1000, sampleInterval: 10 as number | null })),
  jobCanonV2SuccessLogs: 7000,
  jobCanonV1Daily: [] as { day: string; count: number; sampleInterval: number | null }[],
  jobCanonV1FallbackLogs: 0,
  samplingRate: 1,
  jobCanonParity: { v1SubsetOfV2: true, paritySource: 'test', buildId: '1', checkedV1Slugs: 3, mismatchCount: 0, mismatches: [] as { slug: string; reason: string }[], error: undefined as string | undefined },
  samplingHistory: { complete: false, blockers: ['history:no-baseline'] },
  workerLogSamplingExpectedDays: [...retirementDays],
  workerLogSamplingBuckets: retirementDays.map((day) => ({
    day,
    rows: 1,
    count: 5000,
    sampleInterval: 10,
  })),
});

describe('cf-observability-audit checks', () => {
  it('accepts only finite full-sampling intervals plus observed upward noise', () => {
    expect(isCloudflareFullSamplingInterval(1.0000109306076446)).toBe(true);
    expect(isCloudflareFullSamplingInterval(1)).toBe(true);
    for (const interval of [null, Number.NaN, 0, 0.5, 0.999999, 0.99995, 1.001]) {
      expect(isCloudflareFullSamplingInterval(interval)).toBe(false);
    }
  });

  it('readies seven UTC days of v2 with sampleInterval 10 and records the miss probability', () => {
    const receipt = evaluateJobCanonV1Retirement(completeJobCanonRetirementSnapshot());
    expect(receipt.blockers).toEqual([]);
    expect(receipt.ready).toBe(true);
    expect(receipt.observedV2Days).toBe(7);
    expect(receipt.v1FallbackLogs).toBe(0);
    expect(Object.values(receipt.sampleIntervalsByDay)).toEqual(Array(7).fill(10));
    expect(receipt.fallbackMissProbability!.perEvent).toBeCloseTo(0.9, 6);
    expect(receipt.fallbackMissProbability!.ifNEvents[10]).toBeCloseTo(0.9 ** 10, 6);
  });

  it('weights the miss probability by per-day volume and returns null without usable intervals', () => {
    const p = estimateFallbackMissProbability([
      { day: 'a', count: 100, sampleInterval: 1 },
      { day: 'b', count: 100, sampleInterval: 10 },
    ]);
    // volume 100 at p=0 and 1000 at p=0.9
    expect(p!.perEvent).toBeCloseTo(900 / 1100, 5);
    expect(estimateFallbackMissProbability([{ day: 'a', count: 5, sampleInterval: null }])).toBeNull();
  });

  it('admits partial sampling up to the threshold but blocks a malformed interval', () => {
    const snapshot = completeJobCanonRetirementSnapshot();
    snapshot.jobCanonV2Daily[0].sampleInterval = JOB_CANON_MAX_SAMPLE_INTERVAL;
    expect(evaluateJobCanonV1Retirement(snapshot).ready).toBe(true);
    snapshot.jobCanonV2Daily[1].sampleInterval = null;
    const receipt = evaluateJobCanonV1Retirement(snapshot);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.some((b) => b.startsWith('sampling-signal:invalid'))).toBe(true);
  });

  it('is not ready with seven complete v2 days at sampleInterval 100 and no v1 observed', () => {
    const snapshot = completeJobCanonRetirementSnapshot();
    for (const d of snapshot.jobCanonV2Daily) d.sampleInterval = 100;
    const receipt = evaluateJobCanonV1Retirement(snapshot);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers).toContain(`sampling-interval-too-coarse:${retirementDays[0]}:100`);
    expect(receipt.fallbackMissProbability!.perEvent).toBeCloseTo(0.99, 6);
  });

  it('is not ready when v1 is not proven a subset of v2', () => {
    const mismatch = completeJobCanonRetirementSnapshot();
    mismatch.jobCanonParity = { ...mismatch.jobCanonParity, v1SubsetOfV2: false, mismatchCount: 1, mismatches: [{ slug: 'x', reason: 'v2-slug-missing:001' }] };
    const receipt = evaluateJobCanonV1Retirement(mismatch);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers).toContain('v1-parity:mismatch:1');
    expect(receipt.mismatches).toHaveLength(1);

    const unverified = completeJobCanonRetirementSnapshot();
    unverified.jobCanonParity = { ...unverified.jobCanonParity, v1SubsetOfV2: false, error: 'HTTP 503' };
    expect(evaluateJobCanonV1Retirement(unverified).blockers).toContain('v1-parity:unverified:HTTP 503');
    const missing = { ...completeJobCanonRetirementSnapshot(), jobCanonParity: undefined };
    expect(evaluateJobCanonV1Retirement(missing).ready).toBe(false);
  });

  it('proves v1 subset of v2 structurally, with entry semantics and capped examples', () => {
    const entry = { it: '/cerca-lavoro-zurigo', en: '/en/find-jobs-zurich' };
    const slug = 'job-a';
    const key = jobCanonV2ShardKey(slug);
    const ok = evaluateJobCanonParity({
      v1Shards: { jo: { [slug]: entry }, zz: null },
      v2Shards: { [key]: { [slug]: { en: '/en/find-jobs-zurich', it: '/cerca-lavoro-zurigo' }, other: {} } },
    });
    expect(ok).toMatchObject({ v1SubsetOfV2: true, checkedV1Slugs: 1, mismatches: [] });
    const differs = evaluateJobCanonParity({
      v1Shards: { jo: { [slug]: entry } },
      v2Shards: { [key]: { [slug]: { it: '/altro' } } },
    });
    expect(differs.v1SubsetOfV2).toBe(false);
    expect(differs.mismatches[0].reason).toContain('entry-differs');
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, entry]));
    const missing = evaluateJobCanonParity({ v1Shards: { s_: many }, v2Shards: {} });
    expect(missing.mismatchCount).toBe(50);
    expect(missing.mismatches).toHaveLength(20);
  });

  it('keeps the shard-key mirror identical to the Worker', () => {
    for (const slug of ['a', 'abteilungsleiter-in-molkerei-migros', 'élan-2026', '1-2-docente']) {
      expect(jobCanonV2ShardKey(slug)).toBe(workerJobCanonV2ShardKey(slug));
    }
  });

  it('is not ready when a v1 fallback was observed', () => {
    const snapshot = completeJobCanonRetirementSnapshot();
    snapshot.jobCanonV1FallbackLogs = 1;
    snapshot.jobCanonV1Daily = [{ day: retirementDays[3], count: 1, sampleInterval: 10 }];
    const receipt = evaluateJobCanonV1Retirement(snapshot);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers).toContain('v1-fallback:1');
  });

  it('is not ready when a day has no v2 event or no stream bucket', () => {
    const noV2 = completeJobCanonRetirementSnapshot();
    noV2.jobCanonV2Daily = noV2.jobCanonV2Daily.slice(1);
    noV2.jobCanonV2SuccessLogs = 6000;
    expect(evaluateJobCanonV1Retirement(noV2).blockers).toContain('v2-days:6/7');

    const missingBucket = completeJobCanonRetirementSnapshot();
    missingBucket.workerLogSamplingBuckets.splice(2, 1);
    expect(evaluateJobCanonV1Retirement(missingBucket).blockers)
      .toContain(`sampling-stream:coverage:${retirementDays[2]}:missing`);

    const emptyBucket = completeJobCanonRetirementSnapshot();
    emptyBucket.workerLogSamplingBuckets[4].count = 0;
    expect(evaluateJobCanonV1Retirement(emptyBucket).ready).toBe(false);

    const noV2Success = completeJobCanonRetirementSnapshot();
    noV2Success.jobCanonV2SuccessLogs = 0;
    expect(evaluateJobCanonV1Retirement(noV2Success).blockers).toContain('v2-success:0');
  });

  it('separates request-line invocation events from structured origin_failure log events', () => {
    const invocation503 = {
      $metadata: { type: 'cf-worker-event', message: 'GET https://frontaliereticino.ch/calcola-stipendio/' },
      $workers: { event: { response: { status: 503 } } },
    };
    const realShapeOriginFailure = {
      $metadata: { type: 'cf-worker', message: '' },
      source: { level: 'info', event: 'origin_failure', reason: 'router-exception' },
    };
    const structuredOriginFailureLog = {
      $metadata: { type: 'cf-worker-log' },
      event: 'origin_failure',
      reason: 'router-exception',
      path: '/calcola-stipendio/',
      status: 503,
    };
    const originFailureLog = {
      $metadata: {
        type: 'cf-worker-log',
        message: '{"event":"origin_failure","reason":"router-exception","path":"/calcola-stipendio/","status":503}',
      },
    };

    expect(isOriginFailureLogEvent(invocation503)).toBe(false);
    expect(isOriginFailureLogEvent(realShapeOriginFailure)).toBe(true);
    expect(isOriginFailureLogEvent({ ...realShapeOriginFailure, source: { event: 'job_canon_v2_success' } })).toBe(false);
    expect(isOriginFailureLogEvent(structuredOriginFailureLog)).toBe(true);
    expect(isOriginFailureLogEvent(originFailureLog)).toBe(true);
    expect(isOriginFailureLogEvent({
      ...structuredOriginFailureLog,
      event: 'other_event',
    })).toBe(false);
    expect(buildOriginFailureLogFilters()).toEqual([
      {
        kind: 'group',
        filterCombination: 'or',
        filters: [
          { key: 'event', operation: 'eq', value: 'origin_failure', type: 'string' },
          { key: '$metadata.message', operation: 'includes', value: '"event":"origin_failure"', type: 'string' },
        ],
      },
    ]);
  });

  it('keeps the leak query aligned with the WAF country scope for legacy Chrome', () => {
    expect(buildBlockedUaFilters('Baiduspider')).toEqual([
      {
        key: '$workers.event.request.headers.user-agent',
        operation: 'includes',
        value: 'Baiduspider',
        type: 'string',
      },
    ]);
    expect(buildBlockedUaFilters('Chrome/99.0.4844.51')).toEqual([
      {
        key: '$workers.event.request.headers.user-agent',
        operation: 'includes',
        value: 'Chrome/99.0.4844.51',
        type: 'string',
      },
      {
        key: '$workers.event.request.cf.country',
        operation: 'eq',
        value: 'CN',
        type: 'string',
      },
    ]);
  });

  it('has ten checks and passes on a healthy week', () => {
    expect(evaluateChecks(healthy, before)).toHaveLength(10);
    expect(failing(healthy)).toEqual([]);
  });

  it('models origin-failure telemetry as aggregate-only instead of claiming one log per 503', () => {
    const check = evaluateChecks({ ...healthy, count503: 100, originFailureLogs: 0 }, before)
      .find(({ id }) => id === 'origin-failure-cause')!;
    expect(check.failed).toBe(true);
    expect(check.value).toContain('aggregati separati');
    expect(check.target).toContain('nessuna pretesa di copertura 1:1');
    expect(check.target).not.toContain('ogni 503');
  });

  it.each([
    ['5xx-burst', { max503PerBucket: 60 }],
    ['origin-failure-cause', { count503: 10, originFailureLogs: 0 }],
    ['internal-crawler-share', { internalCrawlerRequests: 260_000 }],
    ['404-share', { count404: 60_000 }],
    ['version-files-share', { versionRequests: 40_000 }],
    ['blocked-bot-leak', { blockedRequests: { Baiduspider: 101 } }],
    ['unknown-bot-share', { topUserAgents: [{ ua: 'NewBot/1.0', count: 60_000 }] }],
    ['googlebot-301-share', { googlebot301: 31_000 }],
    ['log-privacy-settings', { redactQueryString: false }],
  ])('%s fails alone on its own signal', (id, change) => {
    const ids = failing({ ...healthy, ...change } as typeof healthy);
    expect(ids).toContain(id);
  });

  it('does not treat a welcomed crawler as unknown', () => {
    expect(failing({ ...healthy, topUserAgents: [{ ua: 'Reflectionbot/1.0', count: 90_000 }] })).toEqual([]);
  });

  it('recognizes ShapBot as a welcomed AI crawler', () => {
    expect(
      failing({
        ...healthy,
        topUserAgents: [
          { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0', count: 90_000 },
        ],
      }),
    ).toEqual([]);
  });

  it('judges sampling and volume only from the cutover date', () => {
    const cutover = new Date('2026-12-01T00:00:00Z');
    const fullSampling = { ...healthy, total: 100_000, samplingRate: 1 };
    expect(failing(fullSampling)).not.toContain('log-budget');
    expect(failing(fullSampling, cutover)).toContain('log-budget');
    const highVolume = { ...healthy, total: 3_000_000 };
    expect(failing(highVolume)).not.toContain('log-budget');
    expect(failing(highVolume, cutover)).toContain('log-budget');
  });

  it('stays report-only until the first window without the pre-fix traffic', () => {
    expect(isReportOnly(new Date('2026-11-08T23:00:00Z'))).toBe(true);
    expect(isReportOnly(new Date('2026-11-09T00:00:00Z'))).toBe(false);
  });

  it('estimates the 2026-10 measured week above the allowance', () => {
    const { ingestGb, storageGbMonth } = estimateMonthlyLogVolume({ events: 9_718_197, avgEventBytes: 5_892 });
    expect(Math.round(ingestGb)).toBe(245);
    expect(Math.round(storageGbMonth)).toBe(57);
  });

  it('builds a stable title and a body with the verification command', () => {
    const check = evaluateChecks({ ...healthy, redactQueryString: false }, before).find((c) => c.failed)!;
    expect(issueTitle(check)).toBe('Cloudflare observability: query string non oscurate nei log');
    expect(issueTitle(check)).not.toMatch(/\d/);
    expect(buildIssueBody(check)).toContain('cf-observability-audit.mjs --dry-run');
    expect(buildIssueBody(check)).not.toContain('bin/rc-env.sh');
  });
});

describe('job-canon retirement evidence in day windows', () => {
  const DAY = 864e5;
  const H = 36e5;
  const base = Date.parse('2026-11-20T00:00:00Z');
  const timeframe = { from: base, to: base + 2 * DAY };
  const v2Filters = [{ key: 'v2' }];
  const v1Filters = [{ key: 'v1' }];
  // interval(length, from) decides what the fake API reports for a window.
  const run = (interval: (len: number, from: number) => number, opts: { maxRequests?: number; v1?: number } = {}) => {
    const calls: { key: string; len: number }[] = [];
    const measure = async (filters: { key: string }[], from: number, to: number) => {
      const key = filters[0].key;
      calls.push({ key, len: to - from });
      if (key === 'v1') return { count: opts.v1 ?? 0, sampleInterval: opts.v1 ? 1 : 0 };
      return { count: 100, sampleInterval: interval(to - from, from) };
    };
    return collectJobCanonDailyWindows({ measure, v2Filters, v1Filters, timeframe, ...opts } as never)
      .then((r) => ({ ...r, calls }));
  };

  it('keeps one query per day when the day window is already fine enough', async () => {
    const r = await run(() => 10);
    expect(r.v2Daily).toEqual([
      { day: '2026-11-20', count: 100, sampleInterval: 10 },
      { day: '2026-11-21', count: 100, sampleInterval: 10 },
    ]);
    expect(r.calls.filter((c) => c.key === 'v2')).toHaveLength(2);
    expect(r.calls.filter((c) => c.key === 'v1')).toHaveLength(2);
  });

  it('splits a coarse day into 6 h windows and reports the max sub-window interval', async () => {
    const r = await run((len) => (len === DAY ? 100 : 1));
    expect(r.v2Daily[0]).toEqual({ day: '2026-11-20', count: 400, sampleInterval: 1 });
    expect(r.calls.filter((c) => c.key === 'v2' && c.len === 6 * H)).toHaveLength(8);
    // v1 absence is probed on the same fine windows.
    expect(r.calls.filter((c) => c.key === 'v1' && c.len === 6 * H)).toHaveLength(8);
  });

  it('narrows to 1 h only where the 6 h window is still coarse', async () => {
    const r = await run((len, from) => (len === DAY ? 100 : len === 6 * H ? (from === base ? 50 : 10) : 2));
    expect(r.calls.filter((c) => c.key === 'v2' && c.len === H)).toHaveLength(6);
    expect(r.v2Daily[0].sampleInterval).toBe(10);
  });

  it('keeps a day above the threshold as the max of its windows', async () => {
    const r = await run(() => 100);
    expect(r.v2Daily[0].sampleInterval).toBe(100);
    expect(JOB_CANON_WINDOW_LADDER_MS).toEqual([DAY, 6 * H, H]);
  });

  it('turns an exhausted request budget into a blocking interval, not a clean day', async () => {
    const r = await run(() => 100, { maxRequests: 3 });
    expect(r.requests).toBeLessThanOrEqual(3);
    expect(r.v2Daily.every((d) => (d.sampleInterval ?? 0) > JOB_CANON_MAX_SAMPLE_INTERVAL)).toBe(true);
  });

  it('records v1 fallbacks found in any window', async () => {
    const r = await run(() => 10, { v1: 2 });
    expect(r.v1Daily.map((d) => d.count)).toEqual([2, 2]);
  });

  it('flags v1 windows skipped by the budget and blocks the receipt', async () => {
    // day 1 v2+v1, day 2 v2 = 3 requests: day 2 v1 is never queried.
    const r = await run(() => 10, { maxRequests: 3 });
    expect(r.v1UnscannedDays).toEqual(['2026-11-21']);
    const snapshot = completeJobCanonRetirementSnapshot() as Record<string, unknown>;
    snapshot.jobCanonV1UnscannedDays = r.v1UnscannedDays;
    const receipt = evaluateJobCanonV1Retirement(snapshot as never);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers).toContain('v1-scan:incomplete:2026-11-21');
  });

  it('feeds the receipt: a day that stays coarse blocks it', async () => {
    const r = await run((_len, from) => (from >= base + DAY ? 100 : 1));
    const snapshot = completeJobCanonRetirementSnapshot();
    snapshot.jobCanonV2Daily = r.v2Daily.map((d) => ({ ...d }));
    const receipt = evaluateJobCanonV1Retirement(snapshot as never);
    expect(receipt.blockers.some((b: string) => b.startsWith('sampling-interval-too-coarse:2026-11-21:100'))).toBe(true);
    expect(receipt.blockers.some((b: string) => b.includes('2026-11-20:'))).toBe(false);
  });
});
