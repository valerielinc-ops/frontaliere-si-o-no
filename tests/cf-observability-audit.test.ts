import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  buildBlockedUaFilters,
  buildOriginFailureLogFilters,
  estimateMonthlyLogVolume,
  evaluateChecks,
  estimateFallbackMissProbability,
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

  it('does not block partial sampling but blocks a malformed interval', () => {
    const snapshot = completeJobCanonRetirementSnapshot();
    snapshot.jobCanonV2Daily[0].sampleInterval = 100;
    snapshot.workerLogSamplingBuckets[0].sampleInterval = 100;
    expect(evaluateJobCanonV1Retirement(snapshot).ready).toBe(true);
    snapshot.jobCanonV2Daily[1].sampleInterval = null;
    const receipt = evaluateJobCanonV1Retirement(snapshot);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.some((b) => b.startsWith('sampling-signal:invalid'))).toBe(true);
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
