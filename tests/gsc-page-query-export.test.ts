import { describe, expect, it, vi } from 'vitest';
import { aggregatePerformance, exportPage, comparePageWindows, monitoringWindows, TOP50_BASELINE } from '../scripts/gsc-page-query-export.mjs';

const day = (date: Date) => date.toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000);
const window = { start: day(daysAgo(65)), end: day(daysAgo(36)) };
const row = (query: string, clicks: number, impressions: number, position: number) => ({
  keys: ['https://frontaliereticino.ch/prezzi-benzina/oggi/', query, 'ita', 'MOBILE'], clicks, impressions, position,
});
const response = (rows: unknown[], metadata?: unknown) => ({ ok: true, json: async () => ({ rows, metadata }) });
const dateRows = Array.from({ length: 30 }, (_, i) => ({ keys: [day(daysAgo(65 - i))], clicks: 1, impressions: 10, position: 5 }));

describe('GSC snippet monitoring', () => {
  it('computes CTR from sums and weights position by impressions', () => {
    expect(aggregatePerformance([{ clicks: 1, impressions: 10, position: 2 }, { clicks: 9, impressions: 90, position: 10 }]))
      .toEqual({ clicks: 10, impressions: 100, ctr: 0.1, position: 9.2 });
    expect(aggregatePerformance([])).toEqual({ clicks: 0, impressions: 0, ctr: null, position: null });
  });

  it('paginates query-country-device rows and fetches independent totals', async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.dimensions[0] === 'date') return response(dateRows);
      if (!body.dimensions.includes('query')) return response([{ keys: [row('', 0, 0, 0).keys[0], 'ita', 'MOBILE'], clicks: 20, impressions: 300, position: 5 }]);
      return response(body.startRow === 0 ? [row('benzina', 10, 100, 4), row('prezzo', 2, 20, 6)] : [row('oggi', 1, 30, 7)]);
    });
    const report = await exportPage({ page: '/prezzi-benzina/oggi/', window, token: 'test', rowLimit: 2, fetchImpl });
    expect(report.rows).toHaveLength(3);
    expect(report.coverage).toMatchObject({ queryRowsTruncated: false, queryImpressionFraction: 0.5, completeQueryCoverage: false });
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toMatchObject({ dimensions: ['date'], dataState: 'all' });
    expect(bodies[1]).toMatchObject({ dimensions: ['page', 'query', 'country', 'device'], dataState: 'final', type: 'web' });
    expect(bodies[2].startRow).toBe(2);
    expect(bodies[3].dimensions).toEqual(['page', 'country', 'device']);
  });

  it('marks capped rows truncated and does not pretend missing rows are zero', async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      const dimensions = JSON.parse(options.body).dimensions;
      return response(dimensions[0] === 'date' ? dateRows : dimensions.includes('query') ? [row('benzina', 2, 10, 4)] : []);
    });
    const before = await exportPage({ page: '/prezzi-benzina/oggi/', window, token: 'test', rowLimit: 1, maxRows: 1, fetchImpl });
    expect(before.coverage.queryRowsTruncated).toBe(true);
    const after = { ...before, window: { start: day(daysAgo(32)), end: day(daysAgo(3)) }, rows: [] };
    expect(comparePageWindows(before, after).status).toBe('not-comparable');
    const uncapped = { ...before, coverage: { ...before.coverage, queryRowsTruncated: false } };
    const compared = comparePageWindows(uncapped, { ...after, coverage: uncapped.coverage });
    expect(compared.queries[0]).toMatchObject({ membership: 'baseline-only', after: null, delta: null });
    expect(comparePageWindows(uncapped, { ...after, window: { ...after.window, end: day(daysAgo(2)) } }).status).toBe('not-comparable');
  });

  it('refuses a window whose last days are still being finalized or absent', async () => {
    const fetchImpl = vi.fn(async (_url, options) => JSON.parse(options.body).dimensions[0] === 'date'
      ? response(dateRows, { first_incomplete_date: window.end }) : response([]));
    const report = await exportPage({ page: '/prezzi-benzina/oggi/', window, token: 'test', fetchImpl });
    expect(report.settlement).toMatchObject({ complete: false, firstIncompleteDate: window.end });
    expect(comparePageWindows(report, report).status).toBe('awaiting-final-data');
    const missing = await exportPage({ page: '/prezzi-benzina/oggi/', window, token: 'test', fetchImpl: async () => response([]) });
    expect(missing.settlement.complete).toBe(false);
    expect(missing.settlement.missingDates).toHaveLength(30);
  });

  it('waits for 30 full Pacific days plus settlement after the real deployment', () => {
    const baselineEnd = new Date(`${TOP50_BASELINE.end}T12:00:00Z`);
    const deployed = new Date(baselineEnd.getTime() + 3 * 86400000);
    const pending = monitoringWindows(deployed.toISOString(), new Date(deployed.getTime() + 30 * 86400000));
    expect(pending.status).toBe('awaiting-complete-window');
    expect(Date.parse(pending.after.end) - Date.parse(pending.after.start)).toBe(29 * 86400000);
    expect(monitoringWindows(deployed.toISOString(), new Date(deployed.getTime() + 33 * 86400000)).status).toBe('ready');
    expect(monitoringWindows(null).status).toBe('awaiting-deployment');
  });
});
