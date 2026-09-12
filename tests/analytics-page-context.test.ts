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
});
