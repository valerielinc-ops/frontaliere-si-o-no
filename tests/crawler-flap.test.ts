// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FLAP_ADVISORY_MIN_JOBS,
  FLAP_ADVISORY_RATIO,
  FLAP_WINDOW_DAYS,
  countResurrectedJobs,
  flapAdvisoryReason,
  flapFromSummary,
  flapSummaryFields,
} from '../scripts/lib/crawler-flap.mjs';
import { buildStableJobIdentity } from '../scripts/lib/job-identity.mjs';
import { nextCrawlerState } from '../scripts/check-crawler-health.mjs';

const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS).toISOString();
const daysAgo = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();

const job = (index: number) => ({
  url: `https://www.example-agency.test/stellen/rolle-${index}-temporaer-${400000 + index}/`,
  title: `Rolle ${index}`,
});
// The expired archive carries no `url`, only the stable identity.
const expiredEntry = (index: number, expiredAt: string) => ({
  slug: `rolle-${index}`,
  sourceIdentity: buildStableJobIdentity(job(index)),
  expiredAt,
});

const observation = (flap: unknown, written = 3300) => ({
  slug: 'agency',
  freshnessAt: NOW_ISO,
  freshnessSource: 'summary',
  jobCount: written,
  activeJobCount: written,
  discovered: written,
  written,
  parsed: written,
  detailDrop: null,
  flap,
  authoritativeEmpty: false,
  earlyExit: false,
  exitCode: null,
});

describe('crawler flap observer (issue 6109)', () => {
  it('counts only new jobs that were expired inside the window', () => {
    const newJobs = [job(1), job(2), job(3), job(4)];
    const expired = [
      expiredEntry(1, daysAgo(0.5)), // flapped: gone one run ago
      expiredEntry(2, daysAgo(1)), // flapped: gone two runs ago
      expiredEntry(3, daysAgo(FLAP_WINDOW_DAYS + 3)), // re-posted weeks later
      expiredEntry(9, daysAgo(1)), // expired and still gone
    ];
    const result = countResurrectedJobs(newJobs, expired, { nowMs: NOW_MS });
    expect(result.resurrected).toBe(2);
    expect(result.windowDays).toBe(FLAP_WINDOW_DAYS);
    expect(result.sample).toEqual([job(1).url, job(2).url]);
  });

  it('round-trips through the summary slice and stays silent when unmeasured', () => {
    const fields = flapSummaryFields({ resurrected: 12, windowDays: FLAP_WINDOW_DAYS });
    expect(flapFromSummary({ ...fields, written: 300 })).toEqual({
      resurrected: 12,
      windowDays: FLAP_WINDOW_DAYS,
      written: 300,
    });
    expect(flapSummaryFields(null)).toEqual({});
    expect(flapFromSummary({ written: 300 })).toBeNull();
  });

  it('raises a crawler-health advisory for a measured flap and not for normal churn', () => {
    // 01-10 shape: hundreds of a ~3300-job slice came back within two runs.
    const flapped = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation({ resurrected: 504, windowDays: FLAP_WINDOW_DAYS, written: 3300 }),
      NOW_ISO,
      NOW_MS,
    ).state;
    expect(flapped.status).toBe('healthy');
    expect(flapped.advisory).toBe(true);
    expect(flapped.advisoryReason).toMatch(/504 job\(s\) came back within 7 day/);

    const churn = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation({ resurrected: FLAP_ADVISORY_MIN_JOBS - 1, windowDays: FLAP_WINDOW_DAYS, written: 100 }),
      NOW_ISO,
      NOW_MS,
    ).state;
    const smallRatio = flapAdvisoryReason({
      resurrected: FLAP_ADVISORY_MIN_JOBS,
      windowDays: FLAP_WINDOW_DAYS,
      written: Math.ceil(FLAP_ADVISORY_MIN_JOBS / FLAP_ADVISORY_RATIO) + 1,
    });
    const unmeasured = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation(null),
      NOW_ISO,
      NOW_MS,
    ).state;
    expect(churn.advisory).toBe(false);
    expect(smallRatio).toBeNull();
    expect(unmeasured.advisory).toBe(false);
  });
});
