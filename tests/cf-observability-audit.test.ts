import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  buildBlockedUaFilters,
  buildOriginFailureLogFilters,
  estimateMonthlyLogVolume,
  evaluateChecks,
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

const retirementDays = Array.from({ length: 7 }, (_, index) => `day-${index + 1}`);
const fullSamplingNoise = [
  1.0000109306076446,
  1.0000032,
  1.0000008,
  1.000019,
  1.0000021,
  1.000008,
  1.0000001,
];
const completeJobCanonRetirementSnapshot = () => ({
  queryWindowDays: 7,
  jobCanonV2SuccessDays: [...retirementDays],
  jobCanonV2SuccessLogs: 7,
  jobCanonV1FallbackLogs: 0,
  samplingRate: 1,
  samplingHistory: { complete: true, blockers: [] },
  jobCanonV2SampleIntervals: [...fullSamplingNoise],
  jobCanonV1SampleIntervals: [],
  workerLogSamplingExpectedDays: [...retirementDays],
  workerLogSamplingBuckets: retirementDays.map((day, index) => ({
    day,
    rows: 1,
    count: 100,
    sampleInterval: fullSamplingNoise[index],
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

  it('readies a complete seven-day retirement receipt despite Cloudflare interval noise', () => {
    const receipt = evaluateJobCanonV1Retirement(completeJobCanonRetirementSnapshot());
    expect(receipt.ready).toBe(true);
    expect(receipt.blockers).toEqual([]);
    expect(receipt.v2SuccessLogs).toBeGreaterThan(0);
    expect(receipt.v1FallbackLogs).toBe(0);
  });

  it.each([
    ['signal', (snapshot: ReturnType<typeof completeJobCanonRetirementSnapshot>) => {
      snapshot.jobCanonV2SampleIntervals[0] = 0.5;
    }, 'sampling-signal:'],
    ['daily stream bucket', (snapshot: ReturnType<typeof completeJobCanonRetirementSnapshot>) => {
      snapshot.workerLogSamplingBuckets[0].sampleInterval = 0.5;
    }, 'sampling-stream:sample-interval:'],
  ])('continues to block a materially partial %s interval', (_label, change, blockerPrefix) => {
    const snapshot = completeJobCanonRetirementSnapshot();
    change(snapshot);
    const receipt = evaluateJobCanonV1Retirement(snapshot);
    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.some((blocker) => blocker.startsWith(blockerPrefix))).toBe(true);
  });

  it('keeps the seven-day v2 traffic and zero-v1-fallback requirements', () => {
    const incompleteWeek = completeJobCanonRetirementSnapshot();
    incompleteWeek.jobCanonV2SuccessDays = retirementDays.slice(1);
    expect(evaluateJobCanonV1Retirement(incompleteWeek).blockers).toContain('v2-days:6/7');

    const noV2Success = completeJobCanonRetirementSnapshot();
    noV2Success.jobCanonV2SuccessLogs = 0;
    expect(evaluateJobCanonV1Retirement(noV2Success).blockers).toContain('v2-success:0');

    const hasV1Fallback = completeJobCanonRetirementSnapshot();
    hasV1Fallback.jobCanonV1FallbackLogs = 1;
    expect(evaluateJobCanonV1Retirement(hasV1Fallback).blockers).toContain('v1-fallback:1');
  });

  it('separates request-line invocation events from structured origin_failure log events', () => {
    const invocation503 = {
      $metadata: { type: 'cf-worker-event', message: 'GET https://frontaliereticino.ch/calcola-stipendio/' },
      $workers: { event: { response: { status: 503 } } },
    };
    const originFailureLog = {
      $metadata: {
        type: 'cf-worker-log',
        message: '{"event":"origin_failure","reason":"router-exception","path":"/calcola-stipendio/","status":503}',
      },
    };

    expect(isOriginFailureLogEvent(invocation503)).toBe(false);
    expect(isOriginFailureLogEvent(originFailureLog)).toBe(true);
    expect(buildOriginFailureLogFilters()).toEqual([
      { key: '$metadata.type', operation: 'eq', value: 'cf-worker-log', type: 'string' },
      { key: '$metadata.message', operation: 'includes', value: '"event":"origin_failure"', type: 'string' },
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
