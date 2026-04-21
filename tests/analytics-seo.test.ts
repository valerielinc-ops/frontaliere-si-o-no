import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  classifySeoPageType,
  trackSeoPageView,
  type SeoPageType,
} from '@/services/analytics-seo';
import { captureEvent as posthogCapture } from '@/services/posthog';

// PostHog is mocked globally in tests/setup.tsx; re-import the mock handle.
const posthogMock = vi.mocked(posthogCapture);

describe('classifySeoPageType', () => {
  describe('F6 fuel_daily', () => {
    const cases: Array<[string, SeoPageType]> = [
      ['/prezzi-diesel/oggi/', 'fuel_daily'],
      ['/prezzi-diesel/chiasso/oggi/', 'fuel_daily'],
      ['/prezzi-benzina/oggi/', 'fuel_daily'],
      ['/prezzi-diesel/chiasso/2026-04/', 'fuel_daily'],
      ['/en/diesel-price-switzerland/today/', 'fuel_daily'],
      ['/en/gasoline-price-switzerland/today/', 'fuel_daily'],
      ['/de/dieselpreis-schweiz/heute/', 'fuel_daily'],
      ['/de/benzinpreis-schweiz/heute/', 'fuel_daily'],
      ['/fr/prix-gasoil-suisse/aujourdhui/', 'fuel_daily'],
      ['/fr/prix-essence-suisse/aujourdhui/', 'fuel_daily'],
    ];
    it.each(cases)('%s classified as %s', (path, type) => {
      expect(classifySeoPageType(path)).toBe(type);
    });
  });

  describe('F5 weekly_employers', () => {
    const cases: Array<[string, SeoPageType]> = [
      ['/aziende-che-assumono/ticino/settimana-corrente/', 'weekly_employers'],
      ['/aziende-che-assumono/lugano/settimana-16-2026/', 'weekly_employers'],
      ['/en/companies-hiring/ticino/current-week/', 'weekly_employers'],
      ['/de/unternehmen-einstellen/lugano/aktuelle-woche/', 'weekly_employers'],
      ['/fr/entreprises-recrutent/ticino/semaine-courante/', 'weekly_employers'],
    ];
    it.each(cases)('%s classified as %s', (path, type) => {
      expect(classifySeoPageType(path)).toBe(type);
    });
  });

  describe('F4 job_market_snapshot', () => {
    const cases: Array<[string, SeoPageType]> = [
      ['/mercato-lavoro-ticino/', 'job_market_snapshot'],
      ['/mercato-lavoro-ticino/settimana-16-2026/', 'job_market_snapshot'],
      ['/mercato-lavoro-ticino/aprile-2026/', 'job_market_snapshot'],
      ['/en/ticino-job-market/', 'job_market_snapshot'],
      ['/en/ticino-job-market/week-16-2026/', 'job_market_snapshot'],
      ['/de/tessiner-arbeitsmarkt/woche-16-2026/', 'job_market_snapshot'],
      ['/fr/marche-travail-tessin/semaine-16-2026/', 'job_market_snapshot'],
    ];
    it.each(cases)('%s classified as %s', (path, type) => {
      expect(classifySeoPageType(path)).toBe(type);
    });
  });

  describe('F2 health_premiums', () => {
    const cases: Array<[string, SeoPageType]> = [
      ['/premi-cassa-malati/', 'health_premiums'],
      ['/premi-cassa-malati/ticino/', 'health_premiums'],
      ['/premi-cassa-malati/ticino/30/', 'health_premiums'],
      ['/en/health-insurance-premiums/ticino/', 'health_premiums'],
      ['/de/krankenkassenpraemien/tessin/', 'health_premiums'],
      ['/fr/primes-assurance-maladie/tessin/', 'health_premiums'],
    ];
    it.each(cases)('%s classified as %s', (path, type) => {
      expect(classifySeoPageType(path)).toBe(type);
    });
  });

  describe('F3b orphan_query_landing', () => {
    const cases: Array<[string, SeoPageType]> = [
      ['/ricerca/lavoro-frontaliere-lugano/', 'orphan_query_landing'],
      ['/en/search/cross-border-jobs-lugano/', 'orphan_query_landing'],
      ['/de/suche/grenzgaenger-jobs-tessin/', 'orphan_query_landing'],
      ['/fr/recherche/emplois-frontaliers-tessin/', 'orphan_query_landing'],
    ];
    it.each(cases)('%s classified as %s', (path, type) => {
      expect(classifySeoPageType(path)).toBe(type);
    });

    it('does not tag a bare /ricerca with no sub-slug', () => {
      expect(classifySeoPageType('/ricerca/')).toBe(null);
    });
  });

  describe('job-board hubs (F3a + city/sector/recency)', () => {
    it('bare job-board listing → job_listing', () => {
      expect(classifySeoPageType('/cerca-lavoro-ticino/')).toBe('job_listing');
      expect(classifySeoPageType('/en/find-jobs-ticino/')).toBe('job_listing');
      expect(classifySeoPageType('/de/jobs-im-tessin/')).toBe('job_listing');
      expect(classifySeoPageType('/fr/trouver-emploi-tessin/')).toBe('job_listing');
    });

    it('city hubs match exact city slugs in every locale', () => {
      expect(classifySeoPageType('/cerca-lavoro-ticino/lugano/')).toBe('city_hub');
      expect(classifySeoPageType('/cerca-lavoro-ticino/mendrisio/')).toBe('city_hub');
      expect(classifySeoPageType('/cerca-lavoro-ticino/bellinzona/')).toBe('city_hub');
      expect(classifySeoPageType('/en/find-jobs-ticino/lugano/')).toBe('city_hub');
      expect(classifySeoPageType('/de/jobs-im-tessin/mendrisio/')).toBe('city_hub');
      expect(classifySeoPageType('/fr/trouver-emploi-tessin/bellinzona/')).toBe('city_hub');
    });

    it('recency hubs match locale-aware recency slugs', () => {
      expect(classifySeoPageType('/cerca-lavoro-ticino/ultimi-3-giorni/')).toBe('recency_hub');
      expect(classifySeoPageType('/cerca-lavoro-ticino/da-ieri/')).toBe('recency_hub');
      expect(classifySeoPageType('/en/find-jobs-ticino/last-3-days/')).toBe('recency_hub');
      expect(classifySeoPageType('/en/find-jobs-ticino/since-yesterday/')).toBe('recency_hub');
      expect(classifySeoPageType('/de/jobs-im-tessin/letzten-3-tage/')).toBe('recency_hub');
      expect(classifySeoPageType('/fr/trouver-emploi-tessin/depuis-hier/')).toBe('recency_hub');
    });

    it('sector hubs classified as sector_hub', () => {
      expect(classifySeoPageType('/cerca-lavoro-ticino/infermieri/')).toBe('sector_hub');
      expect(classifySeoPageType('/cerca-lavoro-ticino/case-anziani/')).toBe('sector_hub');
      expect(classifySeoPageType('/cerca-lavoro-ticino/educatori/')).toBe('sector_hub');
    });

    it('full job-detail slugs classified as job_listing', () => {
      // Real job detail slug: many hyphens (>=4 parts) — covers F3a title
      // optimization impact.
      expect(
        classifySeoPageType('/cerca-lavoro-ticino/software-engineer-swisscom-lugano-12345/'),
      ).toBe('job_listing');
      expect(
        classifySeoPageType('/en/find-jobs-ticino/cross-border-worker-financial-analyst-lugano/'),
      ).toBe('job_listing');
    });
  });

  describe('salary_hub', () => {
    it('long-tail salary hub pages are tagged, calculator home is not', () => {
      expect(
        classifySeoPageType('/calcola-stipendio/stipendio-netto-80000-chf/'),
      ).toBe('salary_hub');
      expect(
        classifySeoPageType('/en/calculate-salary/net-salary-80000-chf/'),
      ).toBe('salary_hub');
      // The bare calculator root is NOT a hub — it's the calculator UI itself.
      expect(classifySeoPageType('/calcola-stipendio/')).toBe(null);
    });
  });

  describe('returns null for untagged paths', () => {
    const paths = [
      '/',
      '',
      '/tasse-e-pensione/',
      '/guida-frontaliere/primo-giorno/',
      '/statistiche/',
      '/privacy/',
      '/en/',
      '/de/',
      '/fr/',
      '/blog/cambio-valuta-2026/',
    ];
    it.each(paths)('%s returns null', (path) => {
      expect(classifySeoPageType(path)).toBe(null);
    });
  });

  describe('input defensive handling', () => {
    it('returns null for non-string / empty pathname', () => {
      expect(classifySeoPageType('')).toBe(null);
      expect(classifySeoPageType(undefined as unknown as string)).toBe(null);
      expect(classifySeoPageType(null as unknown as string)).toBe(null);
    });
  });
});

describe('trackSeoPageView', () => {
  beforeEach(() => {
    posthogMock.mockClear();
    // Clear gtag between tests so one test's stub doesn't leak into another.
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
  });

  it('emits seo_page_view to PostHog AND gtag for a tagged page', () => {
    const gtagSpy = vi.fn();
    (window as unknown as { gtag: typeof gtagSpy }).gtag = gtagSpy;

    trackSeoPageView('/prezzi-diesel/oggi/');

    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'fuel_daily',
      pathname: '/prezzi-diesel/oggi/',
      locale: 'it',
    });
    expect(gtagSpy).toHaveBeenCalledWith('event', 'seo_page_view', {
      seo_page_type: 'fuel_daily',
      page_path: '/prezzi-diesel/oggi/',
      locale: 'it',
    });
  });

  it('skips emission entirely when path is not a tagged SEO page', () => {
    const gtagSpy = vi.fn();
    (window as unknown as { gtag: typeof gtagSpy }).gtag = gtagSpy;

    trackSeoPageView('/privacy/');

    expect(posthogMock).not.toHaveBeenCalled();
    expect(gtagSpy).not.toHaveBeenCalled();
  });

  it('still emits to PostHog when gtag is not loaded', () => {
    // gtag stays undefined — simulates ad-blocker or race before gtag.js loads.
    trackSeoPageView('/en/ticino-job-market/');
    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', {
      seo_page_type: 'job_market_snapshot',
      pathname: '/en/ticino-job-market/',
      locale: 'en',
    });
  });

  it('never throws when gtag implementation is faulty', () => {
    const faulty = vi.fn(() => {
      throw new Error('gtag refused');
    });
    (window as unknown as { gtag: typeof faulty }).gtag = faulty;

    expect(() => trackSeoPageView('/premi-cassa-malati/ticino/')).not.toThrow();
    expect(posthogMock).toHaveBeenCalledTimes(1);
  });

  it('detects locale correctly for localized paths', () => {
    trackSeoPageView('/de/unternehmen-einstellen/lugano/aktuelle-woche/');
    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', expect.objectContaining({ locale: 'de' }));
    posthogMock.mockClear();

    trackSeoPageView('/fr/entreprises-recrutent/ticino/semaine-courante/');
    expect(posthogMock).toHaveBeenCalledWith('seo_page_view', expect.objectContaining({ locale: 'fr' }));
  });
});
