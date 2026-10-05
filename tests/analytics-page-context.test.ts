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

  it('classifies published data directories as directory page families', () => {
    const cases = [
      ['/aziende/medacta-international/', 'directory_employer_profile'],
      ['/en/companies-hiring/lugano/current-week/', 'directory_employer_weekly'],
      ['/farmacie-di-turno/ticino/', 'directory_pharmacy'],
      ['/de/gesundheitseinrichtungen/ospedale-regionale-lugano/', 'directory_health_facility'],
      ['/vivere-in-ticino/comuni-di-frontiera/maslianico/', 'directory_border_municipality'],
      ['/fr/impots-frontaliers-commune/maslianico/', 'directory_fiscal_municipality'],
      ['/aste-targhe-svizzera/ticino/', 'directory_plate_auction'],
    ] as const;

    for (const [path, pageTemplate] of cases) {
      expect(deriveAnalyticsPageContext(path), path).toMatchObject({
        contentGroup: 'directory',
        pageTemplate,
        siteSection: 'directory',
        routeFamily: pageTemplate,
      });
    }
  });

  it('classifies the events section by template and locale', () => {
    expect(deriveAnalyticsPageContext('/eventi/')).toMatchObject({
      contentGroup: 'events',
      pageTemplate: 'events_index',
      siteSection: 'events',
      routeFamily: 'events_index',
      contentLocale: 'it',
    });

    expect(deriveAnalyticsPageContext('/de/veranstaltungen/tessin/diese-woche/')).toMatchObject({
      contentGroup: 'events',
      pageTemplate: 'events_digest',
      contentLocale: 'de',
    });

    expect(deriveAnalyticsPageContext('/fr/evenements/tessin/autres-evenements/')).toMatchObject({
      pageTemplate: 'events_other',
      routeFamily: 'events_other',
      contentLocale: 'fr',
    });

    expect(deriveAnalyticsPageContext('/en/events/ticino/lugano/concerto-2026-07-04/')).toMatchObject({
      pageTemplate: 'event_detail',
      routeFamily: 'event_detail',
      contentLocale: 'en',
    });

    expect(deriveAnalyticsPageContext('/eventi/ticino/lugano/page-2/')).toMatchObject({
      pageTemplate: 'events_overflow',
      routeFamily: 'events_overflow',
    });
  });
});
