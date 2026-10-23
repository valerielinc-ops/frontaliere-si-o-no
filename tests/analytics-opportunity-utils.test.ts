import { describe, expect, it } from 'vitest';

import {
  aggregateRowsByTemplate,
  buildAnalyticsSnapshot,
  buildNearWinQueries,
  classifyAnalyticsPath,
  classifyAnalyticsRecoveryPath,
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
    expect(classifyAnalyticsPath('/cerca-lavoro-ticino/infermieri/')).toMatchObject({
      pageTemplate: 'jobs_sector',
      routeFamily: 'jobs_sector',
    });
    expect(classifyAnalyticsPath('/cerca-lavoro-ticino/educatori-sociali/')).toMatchObject({
      pageTemplate: 'job_detail',
      routeFamily: 'job_detail',
    });
  });

  it('uses the canonical article-section registry for all four locales and both sections', () => {
    const cases = [
      ['/articoli-frontaliere/permesso-g/', 'it'],
      ['/en/cross-border-articles/permit-g/', 'en'],
      ['/de/grenzgaenger-artikel/permit-g/', 'de'],
      ['/fr/articles-frontalier/permis-g/', 'fr'],
      ['/it-articolo/unknown/', 'it'],
      ['/en/swiss-articles/work-in-switzerland/', 'en'],
      ['/de/schweiz-artikel/arbeit/', 'de'],
      ['/fr/articles-suisse/travail/', 'fr'],
    ];

    for (const [path, locale] of cases) {
      const context = classifyAnalyticsPath(path);
      if (path.includes('unknown')) {
        expect(context).toMatchObject({ contentGroup: 'other', contentLocale: locale });
      } else {
        expect(context).toMatchObject({ contentGroup: 'articles', pageTemplate: 'article_detail', contentLocale: locale });
      }
    }
  });

  it('resolves canton from the locale-specific canonical job-board section registry', () => {
    expect(classifyAnalyticsRecoveryPath('/cerca-lavoro-ticino/ricerca-infermieri/')).toMatchObject({ contentLocale: 'it', canton: 'TI' });
    expect(classifyAnalyticsRecoveryPath('/en/find-jobs-geneva/search-nurse/')).toMatchObject({ contentLocale: 'en', canton: 'GE' });
    expect(classifyAnalyticsRecoveryPath('/de/jobs-in-der-waadt/suche-pflege/')).toMatchObject({ contentLocale: 'de', canton: 'VD' });
    expect(classifyAnalyticsRecoveryPath('/fr/trouver-emploi-vaud/recherche-soins/')).toMatchObject({ contentLocale: 'fr', canton: 'VD' });
    expect(classifyAnalyticsRecoveryPath('/de/jobs-im-tessin/')).toMatchObject({ contentLocale: 'de', canton: 'TI' });
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
