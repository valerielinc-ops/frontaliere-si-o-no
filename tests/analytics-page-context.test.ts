import { describe, expect, it } from 'vitest';

import { deriveAnalyticsPageContext } from '@/services/analyticsPageContext';

describe('deriveAnalyticsPageContext', () => {
  it('classifies job detail pages', () => {
    expect(
      deriveAnalyticsPageContext('/cerca-lavoro-ticino/software-engineer-swisscom-lugano'),
    ).toMatchObject({
      contentGroup: 'jobs',
      pageTemplate: 'job_detail',
      siteSection: 'jobs',
      contentLocale: 'it',
    });
  });

  it('classifies localized job search and company pages', () => {
    expect(
      deriveAnalyticsPageContext('/en/find-jobs-ticino/search-lugano'),
    ).toMatchObject({
      pageTemplate: 'jobs_search',
      contentLocale: 'en',
    });

    expect(
      deriveAnalyticsPageContext('/de/jobs-im-tessin/unternehmen-swisscom'),
    ).toMatchObject({
      pageTemplate: 'jobs_company',
      contentLocale: 'de',
    });

    expect(
      deriveAnalyticsPageContext('/en/find-jobs-zurich'),
    ).toMatchObject({
      contentGroup: 'jobs',
      pageTemplate: 'jobs_index',
      routeFamily: 'jobs_index',
      contentLocale: 'en',
    });
  });

  it('keeps sector hubs out of the job-detail template', () => {
    expect(
      deriveAnalyticsPageContext('/cerca-lavoro-ticino/infermieri/'),
    ).toMatchObject({
      pageTemplate: 'jobs_sector',
      routeFamily: 'jobs_sector',
    });

    expect(
      deriveAnalyticsPageContext('/en/find-jobs-ticino/nurses/'),
    ).toMatchObject({
      pageTemplate: 'jobs_sector',
      routeFamily: 'jobs_sector',
      contentLocale: 'en',
    });
  });

  it('classifies article and stats pages', () => {
    expect(
      deriveAnalyticsPageContext('/fr/articles-frontaliers/imposition-frontaliers-2026'),
    ).toMatchObject({
      contentGroup: 'articles',
      pageTemplate: 'article_detail',
      contentLocale: 'fr',
    });

    expect(
      deriveAnalyticsPageContext('/statistiche'),
    ).toMatchObject({
      contentGroup: 'stats',
      pageTemplate: 'stats_index',
    });
  });

  it('classifies fuel, health and border-wait detail pages', () => {
    expect(deriveAnalyticsPageContext('/en/fuel-prices/today')).toMatchObject({
      contentGroup: 'stats',
      pageTemplate: 'fuel_detail',
      siteSection: 'stats',
      routeFamily: 'fuel',
      contentLocale: 'en',
    });

    expect(deriveAnalyticsPageContext('/premi-cassa-malati/ticino')).toMatchObject({
      contentGroup: 'stats',
      pageTemplate: 'health_detail',
      routeFamily: 'health',
    });

    expect(deriveAnalyticsPageContext('/fr/temps-attente-frontiere/chiasso')).toMatchObject({
      contentGroup: 'guides',
      pageTemplate: 'border_wait',
      siteSection: 'guide',
      routeFamily: 'border_wait',
      contentLocale: 'fr',
    });
  });
});
