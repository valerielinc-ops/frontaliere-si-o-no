import { describe, expect, it } from 'vitest';
import { fetchExpiredJobGa4Traffic } from '../scripts/lib/evidence/expiredJobGa4Traffic.mjs';
import {
  EXPIRED_JOB_EDGE_GA4_MAX_AGE_MS,
  isEdgeServedExpiredJob,
  isExpiredJobGa4EvidenceUsable,
  shouldSkipExpiredJobStaticPage,
} from '../build-plugins/shared/expiredJobEdgePolicy.mjs';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const evidence = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  generatedAt: new Date(NOW).toISOString(),
  dateRange: { startDate: '2026-08-12', endDate: '2026-11-09' },
  pages: {},
  coverage: { complete: true, returnedRows: 0, reportedRows: 0 },
  ...overrides,
});

describe('fetchExpiredJobGa4Traffic', () => {
  it('requests all pagePath sessions without a medium filter and paginates to rowCount', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let page = 0;
    const result = await fetchExpiredJobGa4Traffic({
      startDate: '2026-08-12',
      endDate: '2026-11-09',
      propertyId: '524485296',
      pageSize: 1,
      now: () => new Date(NOW),
      getTokenImpl: async () => 'test-token',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        page += 1;
        return new Response(JSON.stringify({
          rowCount: 2,
          rows: page === 1
            ? [{ dimensionValues: [{ value: '/cerca-lavoro-ticino/job?utm_source=newsletter' }], metricValues: [{ value: '1' }] }]
            : [{ dimensionValues: [{ value: '/en/find-jobs-ticino/job/' }], metricValues: [{ value: '2' }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      dateRanges: [{ startDate: '2026-08-12', endDate: '2026-11-09' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }],
    });
    expect(bodies[0]).not.toHaveProperty('dimensionFilter');
    expect(bodies[1].offset).toBe(1);
    expect(result.pages).toEqual({
      '/cerca-lavoro-ticino/job/': 1,
      '/en/find-jobs-ticino/job/': 2,
    });
    expect(result.coverage).toMatchObject({ complete: true, returnedRows: 2, reportedRows: 2, pageCount: 2 });
    expect(result.dateRange).toEqual({ startDate: '2026-08-12', endDate: '2026-11-09' });
  });

  it('keeps incomplete and failed reports explicitly unusable', async () => {
    const incomplete = await fetchExpiredJobGa4Traffic({
      startDate: '2026-08-12', endDate: '2026-11-09', propertyId: '524485296', now: () => new Date(NOW),
      getTokenImpl: async () => 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ rowCount: 2, rows: [] }), { status: 200 }),
    });
    const failed = await fetchExpiredJobGa4Traffic({
      startDate: '2026-08-12', endDate: '2026-11-09', propertyId: '524485296', now: () => new Date(NOW),
      getTokenImpl: async () => 'test-token',
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    expect(incomplete.coverage.complete).toBe(false);
    expect(failed.coverage.complete).toBe(false);
    expect(failed.error).toBe('GA4 request failed (503)');
  });
});

describe('expired job edge selection', () => {
  const paths = ['/cerca-lavoro-ticino/job/', '/en/find-jobs-ticino/job/'];

  it('selects only P1 noindex pages with fresh complete GA4 zero-session evidence', () => {
    expect(isEdgeServedExpiredJob({ p1Noindex: true, paths, ga4Evidence: evidence(), nowMs: NOW })).toBe(true);
    expect(isEdgeServedExpiredJob({ p1Noindex: false, paths, ga4Evidence: evidence(), nowMs: NOW })).toBe(false);
    expect(isEdgeServedExpiredJob({
      p1Noindex: true, paths, ga4Evidence: evidence({ pages: { '/en/find-jobs-ticino/job/': 1 } }), nowMs: NOW,
    })).toBe(false);
  });

  it('skips static output only after a selected page is recorded for its enabled section', () => {
    const requestedSections = ['zurigo'];
    expect(shouldSkipExpiredJobStaticPage({
      selected: true, section: 'zurigo', requestedSections, datasetRecordAdded: true,
    })).toBe(true);
    expect(shouldSkipExpiredJobStaticPage({
      selected: true, section: 'berna', requestedSections, datasetRecordAdded: true,
    })).toBe(false);
    expect(shouldSkipExpiredJobStaticPage({
      selected: true, section: 'zurigo', requestedSections, datasetRecordAdded: false,
    })).toBe(false);
    expect(shouldSkipExpiredJobStaticPage({
      selected: false, section: 'zurigo', requestedSections, datasetRecordAdded: true,
    })).toBe(false);
    expect(shouldSkipExpiredJobStaticPage({
      selected: true, section: 'zurigo', requestedSections: [], datasetRecordAdded: true,
    })).toBe(false);
  });

  it('fails closed on incomplete, stale, future-dated, or invalid coverage', () => {
    expect(isExpiredJobGa4EvidenceUsable(evidence({ coverage: { complete: false, returnedRows: 0, reportedRows: 0 } }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ generatedAt: new Date(NOW - EXPIRED_JOB_EDGE_GA4_MAX_AGE_MS - 1).toISOString() }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ generatedAt: new Date(NOW + 1).toISOString() }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ coverage: { complete: true, returnedRows: 0, reportedRows: 1 } }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ dateRange: { startDate: 'bad', endDate: '2026-11-09' } }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ dateRange: { startDate: '2026-99-99', endDate: '2026-11-09' } }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({ dateRange: { startDate: '2026-02-30', endDate: '2026-03-01' } }), NOW)).toBe(false);
    expect(isExpiredJobGa4EvidenceUsable(evidence({
      dateRange: { startDate: '2026-11-10', endDate: '2026-11-11' },
    }), NOW)).toBe(false);
    expect(isEdgeServedExpiredJob({ p1Noindex: true, paths, ga4Evidence: null, nowMs: NOW })).toBe(false);
  });

  it('requires every tracked path and a valid non-empty path set', () => {
    expect(isEdgeServedExpiredJob({ p1Noindex: true, paths: [], ga4Evidence: evidence(), nowMs: NOW })).toBe(false);
    expect(isEdgeServedExpiredJob({ p1Noindex: true, paths: ['/cerca-lavoro-ticino/job/', ''], ga4Evidence: evidence(), nowMs: NOW })).toBe(false);
    expect(isEdgeServedExpiredJob({
      p1Noindex: true,
      paths,
      ga4Evidence: evidence({ pages: { '/cerca-lavoro-ticino/job/': 'invalid' } }),
      nowMs: NOW,
    })).toBe(false);
    expect(isEdgeServedExpiredJob({
      p1Noindex: true,
      paths,
      ga4Evidence: evidence({ pages: { '/cerca-lavoro-ticino/job/': null } }),
      nowMs: NOW,
    })).toBe(false);
  });
});
