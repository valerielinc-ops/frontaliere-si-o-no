import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  estimateMonthlyLogVolume,
  evaluateChecks,
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

describe('cf-observability-audit checks', () => {
  it('has ten checks and passes on a healthy week', () => {
    expect(evaluateChecks(healthy, before)).toHaveLength(10);
    expect(failing(healthy)).toEqual([]);
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
    ['log-budget', { total: 3_000_000 }],
  ])('%s fails alone on its own signal', (id, change) => {
    const ids = failing({ ...healthy, ...change } as typeof healthy);
    expect(ids).toContain(id);
  });

  it('does not treat a welcomed crawler as unknown', () => {
    expect(failing({ ...healthy, topUserAgents: [{ ua: 'Reflectionbot/1.0', count: 90_000 }] })).toEqual([]);
  });

  it('requires the 0.1 sampling rate only from the cutover date', () => {
    const fullSampling = { ...healthy, total: 100_000, samplingRate: 1 };
    expect(failing(fullSampling)).not.toContain('log-budget');
    expect(failing(fullSampling, new Date('2026-12-01T00:00:00Z'))).toContain('log-budget');
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
  });
});
