import { describe, expect, it, vi } from 'vitest';
import {
  ADSENSE_LOW_SAMPLE_REQUESTS,
  GA4_AD_PAGE_DIAG_METRICS,
  GA4_AD_PAGE_DIAG_QUERY_METRICS,
  GA4_AD_PAGE_DIAG_UNQUERIED_METRICS,
  GA4_LIFECYCLE_EVENTS,
  GA4_LOW_SAMPLE_EVENTS,
  GA4_OFFERWALL_SNAPSHOT_METRICS,
  buildAdsenseUnitReport,
  buildGa4Rows,
  buildLifecycleSummary,
  buildSnapshotRows,
  classifyMetricValue,
  ga4ReportCompleteness,
  renderAdsPerformanceMarkdown,
  resolveAdsReportWindow,
} from '../scripts/lib/ads-performance-report.mjs';
import { AD_CLIENT } from '../services/adsenseSlots.ts';
import { fetchAdsenseData, fetchGa4Data, parseCliArgs } from '../scripts/ads-performance-report.mjs';

const NOW = new Date('2026-10-23T12:00:00.000Z');

function settledWindow() {
  return { start: '2026-10-01', end: '2026-10-20', settled: true, inclusiveDays: 20 };
}

function ga4CompatibilityResponse(body: Record<string, unknown>) {
  return Response.json({
    dimensionCompatibilities: ((body.dimensions as Array<{ name: string }>) || []).map(({ name }) => ({
      dimensionMetadata: { apiName: name }, compatibility: 'COMPATIBLE',
    })),
    metricCompatibilities: ((body.metrics as Array<{ name: string }>) || []).map(({ name }) => ({
      metricMetadata: { apiName: name }, compatibility: 'COMPATIBLE',
    })),
  });
}

describe('ads performance report helpers', () => {
  it('uses a settled inclusive window and rejects an open explicit end date', () => {
    expect(resolveAdsReportWindow({ days: 3, now: NOW })).toMatchObject({
      start: '2026-10-19', end: '2026-10-21', inclusive: true, settled: true,
      inclusiveDays: 3, processingLagDays: 2,
    });
    expect(() => resolveAdsReportWindow({ startDate: '2026-10-20', endDate: '2026-10-22', now: NOW }))
      .toThrow('--end must be on or before 2026-10-21');
    expect(() => resolveAdsReportWindow({ startDate: '2026-10-20', now: NOW }))
      .toThrow('provide both --start and --end');
  });

  it('distinguishes missing, zero, low sample and available values', () => {
    expect(classifyMetricValue(null)).toBe('missing');
    expect(classifyMetricValue(0)).toBe('zero');
    expect(classifyMetricValue(20, { sampleSize: 20, lowSampleBelow: 100 })).toBe('low_sample');
    expect(classifyMetricValue(100, { sampleSize: 100, lowSampleBelow: 100 })).toBe('available');
    expect(ADSENSE_LOW_SAMPLE_REQUESTS).toBe(1000);
    expect(GA4_LOW_SAMPLE_EVENTS).toBe(100);
  });

  it('keeps currency, window, aliases, ratios and estimated earnings from the validated AdSense helper', () => {
    const report = buildAdsenseUnitReport({
      status: 'complete',
      source: 'AdSense API v2',
      sourceUrl: 'https://developers.google.com/adsense/management/reference/rest/v2/Metric',
      account: 'accounts/pub-1',
      domain: 'frontaliereticino.ch',
      currencyCode: 'EUR',
      fetchedAt: '2026-10-21T12:00:00.000Z',
      returnedRows: 1,
      totalMatchedRows: 1,
      window: { start: '2026-10-01', end: '2026-10-20', inclusive: true, settled: true, accountTimeZone: 'Europe/Rome' },
      warnings: [],
      dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME', 'PLATFORM_TYPE_CODE', 'DOMAIN_NAME'],
      metrics: ['AD_REQUESTS', 'ESTIMATED_EARNINGS'],
      attributionLimit: 'no page allocation',
      revenueBasis: 'ESTIMATED_EARNINGS',
      activeViewCountAvailability: 'ratios only',
      rows: [{
        adUnitId: 'ca-pub-1:123', slot: '123', adUnitName: 'FT_UNIT', device: 'HighEndMobile',
        domain: 'frontaliereticino.ch', placements: ['FIRST', 'SECOND'], registeredManualUnit: true, sharedUnit: true,
        requests: 900, matched: 800, impressions: 850, measurableRatio: 0.9, viewableRatio: 0.25,
        measurableCount: null, viewableCount: null, estimatedEarnings: 12.5, currencyCode: 'EUR',
      }],
    });
    expect(report).toMatchObject({
      status: 'ok', dataStatus: 'available', currencyCode: 'EUR',
      window: { start: '2026-10-01', end: '2026-10-20', accountTimeZone: 'Europe/Rome' },
      rows: [{
        slotId: '123', device: 'HighEndMobile', surfaceAliases: ['FIRST', 'SECOND'],
        surfaceAttribution: 'shared_registry_aliases', estimatedEarnings: 12.5,
        requestSampleStatus: 'low_sample', measurabilityStatus: 'available', viewabilityStatus: 'available',
      }],
    });
    expect(report.rows[0].measurableCount).toBeNull();
    expect(report.rows[0].viewableCount).toBeNull();
    expect(report.metricLimit).toContain('ratios only');
  });

  it('treats no AdSense rows as an empty report, not per-slot zero earnings', () => {
    expect(buildAdsenseUnitReport({ status: 'complete', rows: [], currencyCode: 'EUR' }))
      .toMatchObject({ status: 'ok', dataStatus: 'zero', rows: [] });
    expect(buildAdsenseUnitReport({ status: 'unmeasurable', reason: 'truncated' }))
      .toMatchObject({ status: 'unavailable', dataStatus: 'missing', rows: [] });
  });

  it('aggregates the real manual lifecycle and keeps absent stages missing for incomplete GA4 data', () => {
    expect(GA4_LIFECYCLE_EVENTS.map((event) => event.name)).toEqual([
      'ad_request', 'ad_waiting', 'ad_filled', 'ad_unfilled', 'ad_collapsed', 'ad_measurable', 'ad_viewable',
    ]);
    const rows = buildGa4Rows({ rows: [{
      dimensionValues: [
        { value: 'ad_filled' }, { value: 'mobile' }, { value: '123' }, { value: 'JOBLIST_INFEED_MOBILE' },
        { value: 'spa' }, { value: 'jobs' }, { value: 'adsense' },
      ],
      metricValues: [{ value: '15' }],
    }] }, [
      'eventName', 'deviceCategory', 'customEvent:slot', 'customEvent:placement', 'customEvent:render_path',
      'customEvent:page_template', 'customEvent:network',
    ]);
    expect(rows[0]).toMatchObject({
      eventName: 'ad_filled', device: 'mobile', slot: '123', placement: 'JOBLIST_INFEED_MOBILE',
      renderPath: 'spa', pageTemplate: 'jobs', network: 'adsense', eventCountStatus: 'low_sample',
    });
    expect(buildLifecycleSummary(rows).find((event) => event.name === 'ad_request'))
      .toMatchObject({ eventCount: 0, dataStatus: 'zero', completenessStatus: 'complete' });
    expect(buildLifecycleSummary([], { complete: false })[0])
      .toMatchObject({ eventCount: null, dataStatus: 'missing', completenessStatus: 'partial' });
  });

  it('preserves missing, invalid and non-finite event and metric values instead of coercing them to zero', () => {
    const invalidValues = [null, undefined, '', 'not-a-number', Infinity];
    for (const eventCount of invalidValues) {
      expect(buildLifecycleSummary([{ eventName: 'ad_request', eventCount }], { complete: true })[0])
        .toMatchObject({ eventCount: null, dataStatus: 'missing', completenessStatus: 'partial' });
      expect(buildSnapshotRows([{
        eventName: 'ad_page_diag', device: 'mobile', eventCount,
        customMetrics: { slots_total: eventCount },
      }], ['ad_page_diag'], ['customEvent:slots_total'], { complete: true })[0])
        .toMatchObject({
          eventCount: null, eventCountStatus: 'missing', completenessStatus: 'partial',
          averages: { slots_total: { value: null, status: 'missing' } },
        });
    }
  });

  it('aggregates Offerwall and ad_page_diag metrics separately and does not convert partial absence to zero', () => {
    const offerwallMetricNames = [...GA4_OFFERWALL_SNAPSHOT_METRICS];
    const offerwallRows = buildGa4Rows({ rows: [{
      dimensionValues: [{ value: 'rewarded_offer_ads_open' }, { value: 'mobile' }],
      metricValues: [{ value: '20' }, { value: '60' }, { value: '30' }, { value: '10' }],
    }] }, ['eventName', 'deviceCategory'], ['eventCount', ...offerwallMetricNames]);
    const offerwall = buildSnapshotRows(offerwallRows, ['rewarded_offer_ads_open', 'rewarded_offer_ads_offerwall'], offerwallMetricNames);
    expect(offerwall.find((row) => row.eventName === 'rewarded_offer_ads_open')).toMatchObject({
      eventCount: 20,
      averages: { ads_total: { value: 3 }, ads_visible: { value: 1.5 }, anchor_visible: { value: 0.5 } },
    });
    expect(offerwall.find((row) => row.eventName === 'rewarded_offer_ads_offerwall'))
      .toMatchObject({ eventCount: 0, eventCountStatus: 'zero' });
    expect(buildSnapshotRows([], ['ad_page_diag'], GA4_AD_PAGE_DIAG_METRICS, { complete: false })[0])
      .toMatchObject({ eventCount: null, eventCountStatus: 'missing', completenessStatus: 'partial' });

    const firstFill = buildSnapshotRows([
      { eventName: 'ad_page_diag', device: 'mobile', eventCount: 1, customMetrics: { first_fill_ms: 1000 } },
      { eventName: 'ad_page_diag', device: 'mobile', eventCount: 9, customMetrics: { first_fill_ms: -9 } },
    ], ['ad_page_diag'], ['customEvent:first_fill_ms']);
    expect(firstFill[0].averages.first_fill_ms).toMatchObject({
      value: null,
      status: 'missing',
      aggregation: 'withheld: aggregate data cannot exclude the -1 no-fill sentinel from the mean',
    });
  });

  it('requires a known GA4 row count and marks truncation/thresholding incomplete', () => {
    expect(ga4ReportCompleteness({ rowCount: 3, rows: [{}, {}] })).toMatchObject({ complete: false, rowCount: 3 });
    expect(ga4ReportCompleteness({ rows: [] })).toMatchObject({ complete: false, rowCount: null });
    expect(ga4ReportCompleteness({ rowCount: 0, rows: [], metadata: { subjectToThresholding: true } }))
      .toMatchObject({ complete: false, rowCount: 0 });
  });

  it('keeps diagnostic definitions unknown when metadata discovery fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/metadata')) return new Response('', { status: 503 });
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      if (url.endsWith(':checkCompatibility')) return ga4CompatibilityResponse(body);
      const dimensions = (body.dimensions as Array<{ name: string }>).map(({ name }) => name);
      const metrics = (body.metrics as Array<{ name: string }>).map(({ name }) => name);
      const requestedEvents = ((body.dimensionFilter as { filter: { inListFilter: { values: string[] } } }).filter.inListFilter.values);
      const eventName = requestedEvents.includes('ad_page_diag') ? 'ad_page_diag'
        : requestedEvents.includes('ad_filled') ? 'ad_filled' : requestedEvents[0];
      return Response.json({
        rowCount: 1,
        rows: [{
          dimensionValues: dimensions.map((name) => ({ value: name === 'eventName' ? eventName : 'mobile' })),
          metricValues: metrics.map(() => ({ value: '20' })),
        }],
      });
    });
    const result = await fetchGa4Data({
      window: settledWindow(), fetchImpl: fetchImpl as typeof fetch,
      getTokenImpl: async () => 'test-token', propertyId: '12345',
    });
    expect(result.status).toBe('partial');
    expect(result.metadataStatus).toBe('unavailable');
    expect(result.missingCustomDimensions).toEqual([]);
    expect(result.unknownCustomDimensions?.length).toBeGreaterThan(0);
    expect(result.missingSnapshotMetrics).toEqual([]);
    expect(result.unknownSnapshotMetrics).toEqual(GA4_OFFERWALL_SNAPSHOT_METRICS);
    expect(result.adPageDiag?.missingMetrics).toEqual([]);
    expect(result.adPageDiag?.unknownMetrics).toEqual(GA4_AD_PAGE_DIAG_QUERY_METRICS);
    expect(result.adPageDiag?.unqueriedMetrics).toEqual([]);
  });

  it('renders aggregate-only fields and omits identifiers or raw page paths', () => {
    const markdown = renderAdsPerformanceMarkdown({
      generatedAt: 'now', window: { start: '2026-10-01', end: '2026-10-20', inclusiveDays: 20 },
      adsense: { status: 'missing_credentials', dataStatus: 'missing' },
      ga4: {
        status: 'ok', lifecycle: [],
        dimensions: [{ eventName: 'ad_filled', device: 'mobile', slot: '123', placement: 'jobs', renderPath: 'spa', pageTemplate: 'jobs', network: 'adsense', eventCount: 5, eventCountStatus: 'low_sample', request_id: 'must-not-show', pagePath: '/private' }],
        offerwallSnapshots: { rows: [], note: 'separate aggregate snapshots' },
        adPageDiag: { status: 'partial', returnedRows: null, rowCount: null, rows: [] },
      },
    });
    expect(markdown).not.toContain('must-not-show');
    expect(markdown).not.toContain('/private');
    expect(markdown).toContain('cannot be joined');
    expect(markdown).toContain('descriptive');
  });

  it('renders thresholding and truncation warnings for each aggregate GA4 section', () => {
    const markdown = renderAdsPerformanceMarkdown({
      generatedAt: 'now', window: { start: '2026-10-01', end: '2026-10-20', inclusiveDays: 20 },
      adsense: { status: 'missing_credentials', dataStatus: 'missing' },
      ga4: {
        status: 'partial', lifecycle: [], dimensions: [], completenessWarnings: [],
        offerwallSnapshots: {
          status: 'partial', returnedRows: 1, rowCount: 2, rows: [],
          warnings: ['GA4 rowCount exceeds returned rows; results are truncated'],
        },
        adPageDiag: {
          status: 'partial', returnedRows: 0, rowCount: 0, rows: [],
          warnings: ['GA4 applied thresholding'],
        },
      },
    });
    expect(markdown).toContain('Offerwall snapshot coverage warnings: GA4 rowCount exceeds returned rows; results are truncated.');
    expect(markdown).toContain('Diagnostic coverage warnings: GA4 applied thresholding.');
    expect(markdown).toContain('Source status: **partial**; report rows 1 / 2.');
  });
});

describe('ads performance report API client', () => {
  it('requires a settled window in the CLI', () => {
    expect(parseCliArgs(['--start=2026-10-01', '--end=2026-10-20', '--json'], NOW).format).toBe('json');
    expect(() => parseCliArgs(['--start=2026-10-22', '--end=2026-10-23'], NOW)).toThrow('--end must be on or before');
  });

  it('queries only the AdSense account matching AD_CLIENT and preserves the validated unit report', async () => {
    const reportHeaders = [
      ['AD_UNIT_ID'], ['AD_UNIT_NAME'], ['PLATFORM_TYPE_CODE'], ['DOMAIN_NAME'], ['AD_REQUESTS'],
      ['MATCHED_AD_REQUESTS'], ['IMPRESSIONS'], ['ACTIVE_VIEW_MEASURABILITY'], ['ACTIVE_VIEW_VIEWABILITY'], ['ESTIMATED_EARNINGS', 'EUR'],
    ].map(([name, currencyCode]) => ({ name, ...(currencyCode ? { currencyCode } : {}) }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/v2/accounts/${AD_CLIENT.replace(/^ca-/, '')}`) {
        return Response.json({ timeZone: { id: 'Europe/Rome' } });
      }
      expect(url.searchParams.get('filters')).toBe('DOMAIN_NAME==frontaliereticino.ch');
      expect(url.searchParams.getAll('dimensions')).toContain('PLATFORM_TYPE_CODE');
      return Response.json({
        startDate: { year: 2026, month: 10, day: 1 },
        endDate: { year: 2026, month: 10, day: 20 },
        headers: reportHeaders,
        totalMatchedRows: '1',
        rows: [{ cells: [
          'ca-pub-1:123', 'FT_UNIT', 'HighEndMobile', 'frontaliereticino.ch', '1200', '1000', '900', '0.8', '0.4', '9.5',
        ].map((value) => ({ value })) }],
      });
    });
    const result = await fetchAdsenseData({ window: settledWindow(), fetchImpl: fetchImpl as typeof fetch, getTokenImpl: async () => 'test-token' });
    expect(result).toMatchObject({
      status: 'ok', currencyCode: 'EUR', window: { accountTimeZone: 'Europe/Rome' },
      rows: [{ slotId: '123', device: 'HighEndMobile', estimatedEarnings: 9.5, currencyCode: 'EUR' }],
    });
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it('checks GA4 metadata and compatibility before bounded queries, including diagnostic dimensions', async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const eventParameters = [
      'slot', 'placement', 'render_path', 'page_template', 'network', 'ad_path',
    ].map((name) => `customEvent:${name}`);
    const allCustomMetrics = [...GA4_OFFERWALL_SNAPSHOT_METRICS, ...GA4_AD_PAGE_DIAG_METRICS];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/metadata')) {
        return Response.json({
          dimensions: ['eventName', 'deviceCategory', ...eventParameters].map((apiName) => ({ apiName })),
          metrics: ['eventCount', ...allCustomMetrics].map((apiName) => ({ apiName })),
        });
      }
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      observedBodies.push(body);
      if (url.endsWith(':checkCompatibility')) return ga4CompatibilityResponse(body);

      const dimensions = (body.dimensions as Array<{ name: string }>).map(({ name }) => name);
      const metrics = (body.metrics as Array<{ name: string }>).map(({ name }) => name);
      const filter = body.dimensionFilter as { filter?: { inListFilter?: { values?: string[] } } };
      const eventName = filter.filter?.inListFilter?.values?.[0];
      const values: Record<string, string> = {
        eventName: eventName || 'ad_filled',
        deviceCategory: 'mobile',
        'customEvent:slot': '123',
        'customEvent:placement': 'JOBLIST_INFEED_MOBILE',
        'customEvent:render_path': 'spa',
        'customEvent:page_template': 'jobs',
        'customEvent:network': 'adsense',
        'customEvent:ad_path': 'loaded',
      };
      const dimensionValues = dimensions.map((name) => ({ value: values[name] || '(not set)' }));
      const metricTotals: Record<string, string> = {
        eventCount: '20',
        'customEvent:ads_total': '60',
        'customEvent:ads_visible': '30',
        'customEvent:anchor_visible': '10',
      };
      for (const name of GA4_AD_PAGE_DIAG_METRICS) metricTotals[name] = '40';
      return Response.json({
        rowCount: 1,
        rows: [{ dimensionValues, metricValues: metrics.map((name) => ({ value: metricTotals[name] || '10' })) }],
      });
    });
    const result = await fetchGa4Data({
      window: settledWindow(), fetchImpl: fetchImpl as typeof fetch,
      getTokenImpl: async () => 'test-token', propertyId: '12345',
    });
    expect(result).toMatchObject({ status: 'partial', property: 'properties/12345', rowCount: 1, returnedRows: 1 });
    expect(result.dimensions?.[0]).toMatchObject({ placement: 'JOBLIST_INFEED_MOBILE', renderPath: 'spa', network: 'adsense' });
    expect(result.offerwallSnapshots?.rows[0]).toMatchObject({
      eventCount: 20, averages: { ads_total: { value: 3 }, ads_visible: { value: 1.5 }, anchor_visible: { value: 0.5 } },
    });
    expect(result.adPageDiag?.rows[0]).toMatchObject({
      eventName: 'ad_page_diag', pageTemplate: 'jobs', adPath: 'loaded', eventCount: 20,
    });
    expect(result.adPageDiag?.unqueriedMetrics).toEqual(GA4_AD_PAGE_DIAG_UNQUERIED_METRICS);
    expect(GA4_AD_PAGE_DIAG_QUERY_METRICS).toHaveLength(9);
    for (const body of observedBodies.filter((entry) => entry.dateRanges)) {
      expect((body.dimensions as unknown[]).length).toBeLessThanOrEqual(9);
      expect((body.metrics as unknown[]).length).toBeLessThanOrEqual(10);
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('/metadata');
    expect(observedBodies.some((body) => !body.dateRanges && body.dimensions)).toBe(true);
    const queriedDimensions = observedBodies.filter((body) => body.dateRanges).flatMap((body) => body.dimensions as Array<{ name: string }>);
    expect(queriedDimensions.map((dimension) => dimension.name)).not.toContain('customEvent:request_id');
    expect(queriedDimensions.map((dimension) => dimension.name)).not.toContain('pagePath');
    expect(JSON.stringify(observedBodies)).not.toContain('request_id');
  });

  it('does not treat omitted compatibility entries as compatible', async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const customDimensions = ['slot', 'placement', 'render_path', 'page_template', 'network', 'ad_path']
      .map((name) => `customEvent:${name}`);
    const customMetrics = [...GA4_OFFERWALL_SNAPSHOT_METRICS, ...GA4_AD_PAGE_DIAG_METRICS];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/metadata')) {
        return Response.json({
          dimensions: ['eventName', 'deviceCategory', ...customDimensions].map((apiName) => ({ apiName })),
          metrics: ['eventCount', ...customMetrics].map((apiName) => ({ apiName })),
        });
      }
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      observedBodies.push(body);
      if (url.endsWith(':checkCompatibility')) {
        const dimensions = (body.dimensions as Array<{ name: string }>).filter(({ name }) => !name.startsWith('customEvent:'));
        const metrics = (body.metrics as Array<{ name: string }>).filter(({ name }) => name === 'eventCount');
        return Response.json({
          dimensionCompatibilities: dimensions.map(({ name }) => ({ dimensionMetadata: { apiName: name }, compatibility: 'COMPATIBLE' })),
          metricCompatibilities: metrics.map(({ name }) => ({ metricMetadata: { apiName: name }, compatibility: 'COMPATIBLE' })),
        });
      }
      const dimensions = (body.dimensions as Array<{ name: string }>).map(({ name }) => name);
      const metricNames = (body.metrics as Array<{ name: string }>).map(({ name }) => name);
      const requestedEvents = ((body.dimensionFilter as { filter: { inListFilter: { values: string[] } } }).filter.inListFilter.values);
      const eventName = requestedEvents.includes('ad_page_diag') ? 'ad_page_diag'
        : requestedEvents.includes('ad_filled') ? 'ad_filled' : requestedEvents[0];
      return Response.json({
        rowCount: 1,
        rows: [{
          dimensionValues: dimensions.map((name) => ({ value: name === 'eventName' ? eventName : 'mobile' })),
          metricValues: metricNames.map(() => ({ value: '20' })),
        }],
      });
    });
    const result = await fetchGa4Data({
      window: settledWindow(), fetchImpl: fetchImpl as typeof fetch,
      getTokenImpl: async () => 'test-token', propertyId: '12345',
    });
    expect(result.status).toBe('partial');
    expect(result.compatibilityStatus).toBe('partial');
    expect(result.adPageDiag?.compatibilityStatus).toBe('partial');
    expect(result.adPageDiag?.availableMetrics).toEqual(['eventCount']);
    expect(result.adPageDiag?.missingMetrics).toEqual(GA4_AD_PAGE_DIAG_QUERY_METRICS);
    expect(result.adPageDiag?.unqueriedMetrics).toEqual(GA4_AD_PAGE_DIAG_UNQUERIED_METRICS);
    for (const body of observedBodies.filter((entry) => entry.dateRanges)) {
      expect((body.dimensions as Array<{ name: string }>).some(({ name }) => customDimensions.includes(name))).toBe(false);
      expect((body.metrics as Array<{ name: string }>).some(({ name }) => customMetrics.includes(name))).toBe(false);
    }
  });

  it('labels missing credentials without erasing a different source result', async () => {
    const adsense = await fetchAdsenseData({ window: settledWindow(), getTokenImpl: async () => null });
    const ga4 = await fetchGa4Data({ window: settledWindow(), getTokenImpl: async () => null });
    expect(adsense.status).toBe('missing_credentials');
    expect(ga4.status).toBe('missing_credentials');
    expect(adsense.rows).toEqual([]);
  });
});
