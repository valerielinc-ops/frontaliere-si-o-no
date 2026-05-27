import { describe, expect, it } from 'vitest';

import {
  aggregateRowsByTemplate,
  buildAnalyticsSnapshot,
  buildNearWinQueries,
  classifyAnalyticsPath,
  clusterTopQueries,
} from '../scripts/lib/analytics-opportunity-utils.mjs';

describe('analytics opportunity utils', () => {
  it('classifies analytics paths into stable templates', () => {
    expect(classifyAnalyticsPath('/en/find-jobs-ticino/search-lugano')).toMatchObject({
      pageTemplate: 'jobs_search',
      contentLocale: 'en',
    });
    expect(classifyAnalyticsPath('/cerca-lavoro-ticino/azienda-swisscom')).toMatchObject({
      pageTemplate: 'jobs_company',
      contentGroup: 'jobs',
    });
  });

  it('aggregates rows by template', () => {
    const rows = aggregateRowsByTemplate([
      { path: '/cerca-lavoro-ticino/a', views: 100, users: 50, avgDuration: 40 },
      { path: '/cerca-lavoro-ticino/b', views: 50, users: 25, avgDuration: 20 },
      { path: '/articoli-frontaliere/test', views: 80, users: 40, avgDuration: 100 },
    ], 'ga4');

    expect(rows[0]).toMatchObject({
      pageTemplate: 'job_detail',
      views: 150,
      users: 75,
    });
  });

  it('extracts near-win queries and clusters', () => {
    const queries = [
      { query: 'lavoro lugano', impressions: 400, clicks: 20, ctr: 5, position: 4.2 },
      { query: 'stipendio frontalieri', impressions: 300, clicks: 30, ctr: 10, position: 3.1 },
      { query: 'permesso g ticino', impressions: 120, clicks: 8, ctr: 6.7, position: 7.5 },
    ];

    const nearWins = buildNearWinQueries(queries);
    const clusters = clusterTopQueries(queries);

    expect(nearWins.length).toBeGreaterThan(0);
    expect(clusters.map((cluster) => cluster.cluster)).toEqual(
      expect.arrayContaining(['jobs', 'salary', 'permits']),
    );
  });

  it('builds a compact snapshot for workflow summaries', () => {
    const snapshot = buildAnalyticsSnapshot({
      generated: '2026-03-09T08:00:00.000Z',
      searchConsole: {
        nearWinQueries: [{ query: 'lavoro ticino', impressions: 100 }],
        pageTemplatePerformance: [{ pageTemplate: 'jobs_search', impressions: 500 }],
      },
      ga4: {
        pageTemplatePerformance: [{ pageTemplate: 'job_detail', views: 600 }],
        internalSearchTerms: [{ term: 'ascona', searches: 12 }],
      },
    });

    expect(snapshot.searchConsole.nearWinQueries).toHaveLength(1);
    expect(snapshot.ga4.internalSearchTerms).toHaveLength(1);
  });
});
