import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowDates } from '../../scripts/lib/perf-sources/safe.mjs';
import { countInclusiveUtcDays } from '../../scripts/lib/analytics-settled-window.mjs';
import { fetchPagePerformance } from '../../scripts/gsc-content-opportunity-score.mjs';
import { fetchGa4ByPage } from '../../scripts/lib/perf-sources/ga4.mjs';
import { fetchGscByPage } from '../../scripts/lib/perf-sources/gsc.mjs';
import { fetchUserValueTotals, fetchSegmentedArpu, fetchRegistrationSummary } from '../../scripts/user-value-report.mjs';

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('inclusive measurement windows and bounded source coverage', () => {
  it.each([1, 7, 30, 90])('requests exactly %i calendar days including both endpoints', (days) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T00:30:00Z'));
    const range = windowDates(days);
    expect(range.end).toBe('2026-03-29');
    expect(countInclusiveUtcDays(range.start, range.end)).toBe(days);
  });

  it('uses the declared 90-day window in the GSC opportunity query', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return response({ rows: [] });
    }));
    const result = await fetchPagePerformance('test-token', 90);
    expect(countInclusiveUtcDays(result.window.start, result.window.end)).toBe(90);
    expect(calls[0].startDate).toBe(result.window.start);
  });

  it('refuses to rank a GSC opportunity population cut off at the safety cap', async () => {
    const fullPage = Array(25_000).fill({ keys: ['https://example.test/a'], clicks: 1 });
    const fetchMock = vi.fn(async () => response({ rows: fullPage }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPagePerformance('test-token', 30)).rejects.toThrow('incomplete');
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('does not mark GSC family coverage complete after ten full pages', async () => {
    const fullPage = Array(25_000).fill({ keys: ['https://example.test/a'], clicks: 1 });
    const fetchImpl = vi.fn(async () => response({ rows: fullPage }));
    await expect(fetchGscByPage({ fetchImpl, getTokenImpl: async () => 'test-token' })).rejects.toThrow('incomplete');
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('fetches the GA4 tail using rowCount before reading daily engagement', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123');
    const calls: any[] = [];
    const makeRow = (path: string) => ({ dimensionValues: [{ value: path }], metricValues: [{ value: '1' }, { value: '0.5' }, { value: '30' }] });
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.dimensions[0].name === 'date') return response({ rows: [] });
      return body.offset === 0
        ? response({ rows: Array(10_000).fill(makeRow('/other/')), rowCount: 10_001 })
        : response({ rows: [makeRow('/articoli-frontaliere/tail/')], rowCount: 10_001 });
    });
    const result = await fetchGa4ByPage({ fetchImpl, getTokenImpl: async () => 'test-token' });
    expect(calls[1].offset).toBe(10_000);
    expect(result.perPath.get('/articoli-frontaliere/tail/')?.pageviews).toBe(1);
    expect(result.coverage).toEqual({ complete: true, returnedRows: 10_001, reportedRows: 10_001 });
  });

  it('does not claim complete GA4 coverage when the API suppresses rows', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123');
    const fetchImpl = vi.fn(async () => response({ rows: [], rowCount: 0, metadata: { subjectToThresholding: true } }));
    await expect(fetchGa4ByPage({ fetchImpl, getTokenImpl: async () => 'test-token' })).rejects.toThrow('restricted');
  });

  it('does not turn a prematurely empty GA4 page into complete coverage', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123');
    const fetchImpl = vi.fn(async () => response({ rows: [], rowCount: 50 }));
    await expect(fetchGa4ByPage({ fetchImpl, getTokenImpl: async () => 'test-token' })).rejects.toThrow('incomplete');
  });
});

describe('user-value property totals', () => {
  const period = { start: '2026-09-01', end: '2026-09-30' };
  const registration = Object.fromEntries(['is_registered', 'is_newsletter_subscriber', 'is_job_alert_subscriber'].map((key) => [key, { registered: false }]));

  it('uses dimensionless users for both summaries even when segment users overlap', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (!body.dimensions) return response({
        rows: [{ metricValues: body.dimensionFilter ? [{ value: '20' }] : [{ value: '10' }, { value: '3' }, { value: '5' }] }],
        metadata: { currencyCode: 'EUR' },
      });
      if (body.metrics[0].name === 'eventCount') return response({ rows: [] });
      return response({ rows: ['true', 'false'].map((value) => ({
        dimensionValues: body.dimensions.map(() => ({ value })),
        metricValues: [{ value: '5' }, { value: '2' }, { value: '3' }],
      })), metadata: { currencyCode: 'EUR' } });
    }));
    const totals = await fetchUserValueTotals('properties/123', {}, period);
    const segmented = await fetchSegmentedArpu('properties/123', {}, period, registration, totals);
    const states = await fetchRegistrationSummary('properties/123', {}, period, totals);
    expect(totals.totals).toMatchObject({ totalAdRevenue: 10, activeUsers: 3, arpu: 3.3333, adImpressions: 20 });
    expect(segmented.totals?.activeUsers).toBe(3);
    expect(states.totals?.activeUsers).toBe(3);
    expect(states.segmentUsersAdditive).toBe(false);
    expect(calls.slice(0, 2).every((body) => !body.dimensions)).toBe(true);
    expect(calls.every((body) => body.dateRanges[0].startDate === period.start && body.dateRanges[0].endDate === period.end)).toBe(true);
  });

  it('keeps restricted property totals unknown instead of summing segments or emitting zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ rows: [], metadata: { subjectToThresholding: true } })));
    const result = await fetchUserValueTotals('properties/123', {}, period);
    expect(result.totals).toBeNull();
    expect(result.error).toContain('restricted');
  });
});
