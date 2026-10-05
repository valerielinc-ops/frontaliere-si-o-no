import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Source Liveness probes GA4, not PostHog (decisione H9 del 2026-10-05,
 * «rimpiazza PostHog con GA4»).
 *
 * WHAT IT IS DEFENDING
 * --------------------
 * PostHog is under quota by choice (owner decision 2026-08-25): it ingests a
 * few dozen events/day against the 500/day floor, permanently. While
 * scripts/check-source-liveness.mjs probed PostHog as the fleet's expected
 * source, every daily run re-opened "PostHog ingestion down — monitors are
 * abstaining" (issue 5921) although the monitors were already reading GA4.
 *
 * The load-bearing test drives the real `main()` with its DEFAULT probe while
 * PostHog would answer "dead" and GA4 answers "alive": no issue may be opened,
 * and PostHog must not even be queried. On the pre-H9 code the default probe
 * is PostHog, so the same test opens the PostHog outage issue and fails.
 */

const runHogQL = vi.fn();
vi.mock('../scripts/lib/posthog-client.mjs', () => ({
  runHogQL: (...args: unknown[]) => runHogQL(...args),
}));

const getServiceAccountToken = vi.fn();
const runGa4Report = vi.fn();
vi.mock('../scripts/lib/ga4-service-account.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getServiceAccountToken: (...args: unknown[]) => getServiceAccountToken(...args),
    runGa4Report: (...args: unknown[]) => runGa4Report(...args),
  };
});

const {
  checkGa4Liveness,
  completeDaysInWindow,
  evaluateLiveness,
  GA4_LIVENESS_LAG_DAYS,
  GA4_MONITORS,
  MONITOR_SOURCE,
} = await import('../scripts/lib/source-liveness.mjs');
const { main, ISSUE_TITLE, RETIRED_ISSUE_TITLES, buildIssueBody } = await import('../scripts/check-source-liveness.mjs');

const silentLogger = { log: () => {} };

/** GA4 `runReport` rows (`date` = YYYYMMDD) for the last `days` days, relative to the real clock. */
function ga4Rows(perDay: number, days = 20) {
  const rows = [];
  const now = new Date();
  for (let back = 0; back <= days; back += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - back);
    rows.push({ dimensionValues: [{ value: d.toISOString().slice(0, 10).replaceAll('-', '') }], metricValues: [{ value: String(perDay) }] });
  }
  return { rows };
}

/** PostHog daily counts as measured on 2026-10-05 (4-87/day, quota not bought): dead by the 500/day floor. */
function posthogUnderQuota() {
  const out: Array<[string, number]> = [];
  const now = new Date();
  for (let back = 0; back <= 20; back += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - back);
    out.push([d.toISOString().slice(0, 10), 31]);
  }
  return { results: out };
}

beforeEach(() => {
  vi.clearAllMocks();
  // PostHog credentials present and PostHog answering "dead": exactly the
  // production state that kept re-opening issue 5921.
  process.env.POSTHOG_PERSONAL_API_KEY = 'test-key';
  process.env.POSTHOG_PROJECT_ID = '157802';
  runHogQL.mockResolvedValue(posthogUnderQuota());
  getServiceAccountToken.mockResolvedValue('ga4-token');
});

afterEach(() => {
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  delete process.env.POSTHOG_PROJECT_ID;
});

describe('check-source-liveness: GA4 is the expected source, PostHog is not (H9)', () => {
  it('opens NO issue and never queries PostHog when GA4 is alive and PostHog is under quota', async () => {
    runGa4Report.mockResolvedValue(ga4Rows(115978));
    const createIssueImpl = vi.fn();
    const resolveIssueImpl = vi.fn();

    const out = await main({ argv: [], createIssueImpl, resolveIssueImpl, logger: silentLogger });

    expect(out.verdict.source).toBe('ga4');
    expect(out.verdict.alive).toBe(true);
    expect(createIssueImpl).not.toHaveBeenCalled();
    expect(runHogQL).not.toHaveBeenCalled();
    // The live verdict closes the GA4 outage title, never the retired PostHog one.
    expect(resolveIssueImpl).toHaveBeenCalledWith(ISSUE_TITLE, { workflow: 'Source Liveness' });
    for (const retired of RETIRED_ISSUE_TITLES) {
      expect(resolveIssueImpl).not.toHaveBeenCalledWith(retired, expect.anything());
    }
  });

  it('positive control: a dead GA4 still raises exactly one outage issue, under the GA4 title', async () => {
    runGa4Report.mockResolvedValue(ga4Rows(12));
    const createIssueImpl = vi.fn(async (_payload: unknown) => ({}));

    await main({ argv: [], createIssueImpl, resolveIssueImpl: vi.fn(), logger: silentLogger });

    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    const payload = createIssueImpl.mock.calls[0][0] as { title: string; description: string };
    expect(payload.title).toBe(ISSUE_TITLE);
    expect(RETIRED_ISSUE_TITLES).not.toContain(payload.title);
    expect(payload.description).toContain('GA4');
    expect(runHogQL).not.toHaveBeenCalled();
  });

  it('a GA4 probe without a service account is "not measurable", never alive', async () => {
    getServiceAccountToken.mockResolvedValue(null);
    const createIssueImpl = vi.fn(async () => ({}));
    const out = await main({ argv: ['--dry-run'], createIssueImpl, resolveIssueImpl: vi.fn(), logger: silentLogger });
    expect(out.verdict.alive).toBe(false);
    expect(out.verdict.credentialsMissing).toBe(true);
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('the outage issue lists the GA4 monitors, not a PostHog fleet', () => {
    const body = buildIssueBody({ alive: false, reason: 'dead', floor: 500, windowDays: 7, deadDays: [] });
    expect(GA4_MONITORS.length).toBeGreaterThan(0);
    for (const m of GA4_MONITORS) expect(body).toContain(m.path);
    expect(body).toMatch(/La sorgente GA4 non risulta viva/);
    expect(MONITOR_SOURCE).toBe('ga4');
  });
});

describe('checkGa4Liveness', () => {
  const now = new Date('2026-10-05T08:00:00Z');

  it('judges the settled GA4 window (today and yesterday excluded), like ga4DateRange(n, 2)', () => {
    expect(GA4_LIVENESS_LAG_DAYS).toBe(2);
    const days = completeDaysInWindow(7, now, GA4_LIVENESS_LAG_DAYS);
    expect(days[0]).toBe('2026-09-27');
    expect(days[days.length - 1]).toBe('2026-10-03');
    expect(days).toHaveLength(7);
  });

  it('keeps the historical default (only today excluded) for lagDays = 1', () => {
    expect(completeDaysInWindow(3, now)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
  });

  it('reads YYYYMMDD rows, filters the production host and rules alive above the floor', async () => {
    const runReportImpl = vi.fn(async () => ({
      rows: ['20260925', '20260926', '20260927', '20260928', '20260929', '20260930', '20261001', '20261002', '20261003']
        .map((d) => ({ dimensionValues: [{ value: d }], metricValues: [{ value: '100292' }] })),
    }));
    const v = await checkGa4Liveness({ windowDays: 7, now, getTokenImpl: async () => 't', runReportImpl });
    expect(v.alive).toBe(true);
    expect(v.source).toBe('ga4');
    expect(v.dailyCounts.get('2026-10-03')).toBe(100292);
    const body = (runReportImpl.mock.calls[0] as unknown as [{ body: Record<string, unknown> }])[0].body;
    expect(JSON.stringify(body)).toContain('hostName');
    expect(body.dateRanges).toEqual([{ startDate: '2026-09-25', endDate: '2026-10-03' }]);
  });

  it('treats a missing day as zero: an empty 200 is not a healthy source', async () => {
    const v = await checkGa4Liveness({ windowDays: 7, now, getTokenImpl: async () => 't', runReportImpl: async () => ({ rows: [] }) });
    expect(v.alive).toBe(false);
    expect(v.deadDays.length).toBe(v.daysEvaluated.length);
  });

  it('a probe that throws is not alive', async () => {
    const v = await checkGa4Liveness({
      windowDays: 7, now, getTokenImpl: async () => 't',
      runReportImpl: async () => { throw new Error('GA4 503'); },
    });
    expect(v.alive).toBe(false);
    expect(v.probeFailed).toBe(true);
  });

  it('a sub-window can be re-ruled from the same counts with the same lag', async () => {
    const rows = ['20260925', '20260926', '20260927', '20260928', '20260929', '20260930', '20261001', '20261002', '20261003']
      .map((d) => ({ dimensionValues: [{ value: d }], metricValues: [{ value: d === '20260927' ? '3' : '90000' }] }));
    const v = await checkGa4Liveness({ windowDays: 7, now, getTokenImpl: async () => 't', runReportImpl: async () => ({ rows }) });
    expect(v.alive).toBe(false);
    const shorter = evaluateLiveness({ dailyCounts: v.dailyCounts, windowDays: 5, now, lagDays: GA4_LIVENESS_LAG_DAYS, source: 'ga4' });
    expect(shorter.alive).toBe(true);
  });
});
