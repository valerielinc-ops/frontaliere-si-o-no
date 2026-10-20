import { describe, expect, it, vi } from 'vitest';
import {
  BASELINE,
  buildComparisonRows,
  buildHistoryEntry,
  fetchGscFinalWindow,
  fetchGscMetrics,
  fetchGscSearchTypeTotals,
  renderMarkdown,
} from '../../scripts/revenue-monitor.mjs';

const window = { start: '2026-10-12', end: '2026-10-18' };
const previousWindow = { start: '2026-10-05', end: '2026-10-11' };
const liveWindow = { start: '2026-10-11', end: '2026-10-17' };
const livePreviousWindow = { start: '2026-10-04', end: '2026-10-10' };
const siteDates = Array.from({ length: 21 }, (_, index) => ({
  keys: [new Date(Date.parse('2026-09-30T00:00:00Z') + index * 86400000).toISOString().slice(0, 10)],
}));
const dateRowsFor = (range: { start: string; end: string }) => siteDates.filter(({ keys: [date] }) => date >= range.start && date <= range.end);
const pageRow = (path: string, clicks: number, impressions: number) => ({
  keys: [`https://frontaliereticino.ch${path}`], clicks, impressions, position: 4,
});

describe('revenue-monitor GSC final windows', () => {
  it('uses explicit final dates and all/date metadata, then shares one selected window across search types', async () => {
    const query = vi.fn(async (_token: string, body: any) => ({
      rows: body.dimensions[0] === 'date'
        ? dateRowsFor({ start: body.startDate, end: body.dataState === 'final' ? '2026-10-18' : body.endDate })
        : [],
      metadata: { firstIncompleteDate: '2026-10-19' },
    }));
    const selected = await fetchGscFinalWindow('token', {
      now: new Date('2026-10-21T06:00:00.000Z'),
      queryImpl: query,
    });
    expect(selected).toMatchObject({
      status: 'measurable',
      window,
      previousWindow,
      previous: { status: 'measurable' },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toMatchObject({
      startDate: '2026-09-30',
      endDate: '2026-10-20',
      type: 'web',
      dataState: 'all',
      dimensions: ['date'],
      rowLimit: 21,
    });
    expect(query.mock.calls[1][1]).toMatchObject({ type: 'web', dataState: 'final', dimensions: ['date'], rowLimit: 21 });
    expect(selected.probe).toMatchObject({
      dataState: 'final',
      firstIncompleteDate: '2026-10-19',
      metadataProbe: { dataState: 'all' },
    });

    await fetchGscSearchTypeTotals('token', 'discover', selected.window, { queryImpl: query });
    expect(query.mock.calls[2][1]).toMatchObject({
      startDate: window.start,
      endDate: window.end,
      type: 'discover',
      dataState: 'all',
      dimensions: ['date'],
    });
    expect(query.mock.calls[3][1]).toMatchObject({
      startDate: window.start,
      endDate: window.end,
      type: 'discover',
      dataState: 'final',
      dimensions: ['date'],
    });
    expect(query.mock.calls[4][1]).toMatchObject({
      startDate: window.start,
      endDate: window.end,
      type: 'discover',
      dataState: 'final',
      dimensions: [],
    });
  });

  it('handles the live protobuf camelCase cutoff and selects only final dates (11–17 vs 4–10 October)', async () => {
    const query = vi.fn(async (_token: string, body: any) => {
      const start = body.startDate;
      const end = body.dataState === 'final' ? '2026-10-17' : '2026-10-19';
      return {
        rows: body.dimensions[0] === 'date' ? dateRowsFor({ start, end }) : [],
        metadata: body.dataState === 'all' ? { firstIncompleteDate: '2026-10-18' } : undefined,
      };
    });
    const selected = await fetchGscFinalWindow('token', {
      now: new Date('2026-10-21T06:00:00.000Z'),
      queryImpl: query,
    });

    expect(selected).toMatchObject({
      status: 'measurable',
      window: liveWindow,
      previousWindow: livePreviousWindow,
      previous: { status: 'measurable' },
      probe: {
        dataState: 'final',
        firstIncompleteDate: '2026-10-18',
        availableDates: expect.arrayContaining(['2026-10-17']),
        metadataProbe: { dataState: 'all', availableDates: expect.arrayContaining(['2026-10-19']) },
      },
    });
    expect(selected.window.end).toBe('2026-10-17');
  });

  it('fails closed on conflicting metadata spellings even when final date rows are complete', async () => {
    const query = vi.fn(async (_token: string, body: any) => ({
      rows: dateRowsFor(window),
      metadata: body.dataState === 'all'
        ? { firstIncompleteDate: '2026-10-17', first_incomplete_date: '2026-10-18' }
        : undefined,
    }));
    const discover = await fetchGscSearchTypeTotals('token', 'discover', window, { queryImpl: query });
    expect(discover).toMatchObject({
      status: 'unmeasurable',
      reason: expect.stringContaining('conflicting metadata'),
      finalityProbe: { status: 'unmeasurable', metadataError: expect.stringContaining('conflicting metadata') },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('paginates page rows by 25k-sized requests and exposes the hard cap without claiming completeness', async () => {
    const calls: any[] = [];
    const query = vi.fn(async (_token: string, body: any) => {
      calls.push(body);
      if (body.dimensions.length === 0) {
        if (body.startDate === previousWindow.start) return { rows: [{ clicks: 20, impressions: 200, position: 5 }] };
        return { rows: [{ clicks: 35, impressions: 350, position: 4 }] };
      }
      const batch = body.startRow === 0
        ? [pageRow('/cerca-lavoro-ticino/job-a/', 1, 10), pageRow('/job-board/job-b/', 2, 20)]
        : [pageRow('/cerca-lavoro-ticino/job-c/', 3, 30), pageRow('/job-board/job-d/', 4, 40)];
      return { rows: batch };
    });
    const metrics = await fetchGscMetrics('token', window, {
      queryImpl: query,
      pageRowLimit: 2,
      maxPageRows: 4,
      previousWindow,
      previousStatus: 'measurable',
    });

    expect(metrics).toMatchObject({ status: 'measurable', clicks7d: 35, clicksPerDay: 5, previous: { clicks: 20, impressions: 200 } });
    expect(metrics.pageCoverage).toMatchObject({
      rowLimitPerPage: 2,
      clientRowCap: 4,
      rowsReturned: 4,
      paginationExhausted: false,
      truncatedAtClientCap: true,
      completeCoverage: false,
    });
    expect(metrics.ctrByBucket['/cerca-lavoro-ticino/']).toBe(10);
    expect(calls.filter((body) => body.dimensions[0] === 'page').map((body) => body.startRow)).toEqual([0, 2]);
    expect(calls.every((body) => body.dataState === 'final')).toBe(true);

    const rows = buildComparisonRows({ adsense: null, gsc: metrics, posthog: null }, BASELINE);
    expect(rows.find((row: any) => row.metric === 'GSC CTR /cerca-lavoro-ticino/ (%)')).toMatchObject({
      current: 10,
      delta: null,
      verdict: '⚪ partial page coverage',
    });
  });

  it('marks page totals exhausted only after a short page, while retaining incomplete-coverage disclosure', async () => {
    const query = vi.fn(async (_token: string, body: any) => {
      if (body.dimensions.length === 0) return { rows: [{ clicks: 7, impressions: 70, position: null }] };
      const batches = [
        [pageRow('/cerca-lavoro-ticino/a/', 1, 10), pageRow('/cerca-lavoro-ticino/b/', 1, 10)],
        [pageRow('/cerca-lavoro-ticino/c/', 1, 10), pageRow('/cerca-lavoro-ticino/d/', 1, 10)],
        [pageRow('/cerca-lavoro-ticino/e/', 1, 10)],
      ];
      return { rows: batches[body.startRow / 2] || [] };
    });
    const metrics = await fetchGscMetrics('token', window, { queryImpl: query, pageRowLimit: 2, maxPageRows: 10 });
    expect(metrics.pageCoverage).toMatchObject({ rowsReturned: 5, paginationExhausted: true, truncatedAtClientCap: false, completeCoverage: false });
    expect(metrics.avgPosition).toBeNull();
  });

  it('does not turn a web totals API failure or malformed row into zero traffic', async () => {
    await expect(fetchGscMetrics('token', window, {
      queryImpl: async () => ({ rows: [] }),
    })).rejects.toThrow(/no valid totals row/);
    await expect(fetchGscMetrics('token', window, {
      queryImpl: async () => ({ rows: [{ clicks: null, impressions: null }] }),
    })).rejects.toThrow(/no valid totals row/);
  });

  it('treats a successful empty non-web response as zero and surfaces query failures', async () => {
    const query = vi.fn(async (_token: string, body: any) => ({
      rows: body.dimensions[0] === 'date' ? dateRowsFor(window) : [],
    }));
    await expect(fetchGscSearchTypeTotals('token', 'googleNews', window, { queryImpl: query })).resolves.toMatchObject({
      status: 'measurable', clicks7d: 0, impressions7d: 0, dataState: 'final', window,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][1]).toMatchObject({ type: 'googleNews', dataState: 'all', dimensions: ['date'], startDate: window.start, endDate: window.end });
    expect(query.mock.calls[1][1]).toMatchObject({ type: 'googleNews', dataState: 'final', dimensions: ['date'], startDate: window.start, endDate: window.end });
    expect(query.mock.calls[2][1]).toMatchObject({ type: 'googleNews', dataState: 'final', dimensions: [], startDate: window.start, endDate: window.end });
    await expect(fetchGscSearchTypeTotals('token', 'discover', window, {
      queryImpl: async () => { throw new Error('GSC 403'); },
    })).rejects.toThrow('GSC 403');
  });

  it('does not report zero for Discover when its own final-date data trails the web window', async () => {
    const query = vi.fn(async (_token: string, body: any) => {
      if (body.type === 'discover' && body.dataState === 'all') {
        return {
          rows: dateRowsFor({ start: window.start, end: '2026-10-16' }),
          metadata: { firstIncompleteDate: '2026-10-17' },
        };
      }
      if (body.type === 'discover' && body.dataState === 'final') {
        return { rows: dateRowsFor({ start: window.start, end: '2026-10-16' }) };
      }
      return { rows: [] };
    });
    const discover = await fetchGscSearchTypeTotals('token', 'discover', window, { queryImpl: query });
    expect(discover).toMatchObject({
      status: 'unmeasurable',
      window,
      reason: expect.stringContaining('Search-type finality probe is incomplete'),
      finalityProbe: { status: 'unmeasurable', firstIncompleteDate: '2026-10-17' },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toMatchObject({ startDate: window.start, endDate: window.end, type: 'discover', dataState: 'all' });
  });

  it('keeps the web period measurable when only previous-period totals fail', async () => {
    const query = vi.fn(async (_token: string, body: any) => {
      if (body.dimensions.length === 0 && body.startDate === previousWindow.start) throw new Error('previous totals 503');
      if (body.dimensions.length === 0) return { rows: [{ clicks: 10, impressions: 100, position: 3 }] };
      return { rows: [] };
    });
    const metrics = await fetchGscMetrics('token', window, {
      queryImpl: query,
      previousWindow,
      previousStatus: 'measurable',
    });
    expect(metrics.status).toBe('measurable');
    expect(metrics.clicks7d).toBe(10);
    expect(metrics.previous).toMatchObject({ status: 'unmeasurable', reason: expect.stringContaining('previous totals 503') });
  });

  it('persists and renders per-source windows, state, page coverage, prior window and errors', () => {
    const current: any = {
      adsense: null,
      gsc: {
        status: 'measurable', clicks7d: 35, clicksPerDay: 5, avgPosition: 4, ctrByBucket: {},
        source: 'Google Search Console Search Analytics', searchType: 'web', dataState: 'final', window,
        pageCoverage: { rowsReturned: 4, clientRowCap: 4, paginationExhausted: false, truncatedAtClientCap: true, completeCoverage: false },
        previous: { status: 'measurable', clicks: 20, impressions: 200, source: 'Google Search Console Search Analytics', searchType: 'web', dataState: 'final', window: previousWindow },
      },
      gscDiscover: { status: 'unmeasurable', reason: 'GSC Discover query failed: 403', window, searchType: 'discover', dataState: 'final' },
      gscNews: { status: 'measurable', clicks7d: 0, impressions7d: 0, window, searchType: 'googleNews', dataState: 'final' },
      gscWindowProbe: { status: 'measurable', probe: { window: { start: '2026-09-30', end: '2026-10-20' }, dataState: 'final', firstIncompleteDate: '2026-10-19', metadataProbe: { dataState: 'all' } } },
      posthog: null,
      warnings: [],
      errors: ['gsc-discover: GSC 403'],
    };
    const rows = buildComparisonRows(current);
    expect(rows.find((row: any) => row.metric === 'GSC clicks / day vs previous final 7d')?.baseline).toBe(2.9);
    const entry: any = buildHistoryEntry(current, rows, '2026-10-20');
    expect(entry.gsc).toMatchObject({ window, dataState: 'final', pageCoverage: { completeCoverage: false }, previous: { window: previousWindow } });
    expect(entry.gscDiscover).toMatchObject({ status: 'unmeasurable', reason: 'GSC Discover query failed: 403', window, dataState: 'final' });
    expect(entry.gscWindowProbe.probe.dataState).toBe('final');
    const markdown = renderMarkdown(rows, current);
    expect(markdown).toContain('## GSC source provenance');
    expect(markdown).toContain('2026-10-12 → 2026-10-18');
    expect(markdown).toContain('completeCoverage=false');
    expect(markdown).toContain('final / date; metadata all/date');
    expect(markdown).toContain('Previous web 7d');
    expect(markdown).toContain('gsc-discover: GSC 403');
  });

  it('does not label an otherwise measurable report healthy when errors exist', () => {
    const current: any = {
      adsense: { currencyCode: 'EUR', revenuePerDay: 0.87, rpm: 0.91, desktopRpm: 1.1, authGateImpressions7d: 618 },
      gsc: {
        status: 'measurable', clicksPerDay: 323, avgPosition: 5.7, ctrByBucket: BASELINE.gsc.ctrByBucket,
        previous: { status: 'measurable', clicks: 2261, window: previousWindow },
      },
      gscDiscover: null,
      gscNews: null,
      posthog: { source: 'posthog', clsP75Mobile: 0.51, clsP75Desktop: 0.18 },
      warnings: [],
      errors: ['gsc-web: GSC 503'],
    };
    const markdown = renderMarkdown(buildComparisonRows(current), current);
    expect(buildComparisonRows(current).some((row: any) => row.verdict.startsWith('⚪ unmeasurable'))).toBe(false);
    expect(markdown).not.toContain('All metrics healthy');
    expect(markdown).toContain('No regressions among measurable metrics; unavailable metrics require review.');
  });
});
