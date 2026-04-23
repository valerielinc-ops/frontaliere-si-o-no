/**
 * Tests for geo-hub city pages (Lugano / Mendrisio / Bellinzona).
 *
 * Covers:
 *  - `cityJobsHub` helper module: paths, SEO copy (count + fire), job matching, counting.
 *  - Router integration: `parsePath` recognizes `/cerca-lavoro-ticino/<city>/` etc.
 *    and `buildPath` emits the clean canonical URL from `{ jobBoardCity }`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePath, buildPath } from '@/services/router';
import {
  CITY_HUB_KEYS,
  CITY_HUB_SLUG,
  allCityHubPaths,
  buildCityHubPath,
  buildCityHubSeo,
  countCityJobsByLocale,
  jobMatchesCity,
  parseCityHubPath,
  CITY_HUB_FIRE_THRESHOLD,
} from '../build-plugins/cityJobsHub';

const YEAR = 2026;

describe('cityJobsHub — paths', () => {
  it('exposes exactly 5 city keys', () => {
    expect(CITY_HUB_KEYS).toEqual(['lugano', 'mendrisio', 'bellinzona', 'locarno', 'chiasso']);
  });

  it('builds canonical path per locale', () => {
    expect(buildCityHubPath('it', 'lugano')).toBe('/cerca-lavoro-ticino/lugano/');
    expect(buildCityHubPath('en', 'lugano')).toBe('/en/find-jobs-ticino/lugano/');
    expect(buildCityHubPath('de', 'mendrisio')).toBe('/de/jobs-im-tessin/mendrisio/');
    expect(buildCityHubPath('fr', 'bellinzona')).toBe('/fr/trouver-emploi-tessin/bellinzona/');
    expect(buildCityHubPath('fr', 'locarno')).toBe('/fr/trouver-emploi-tessin/locarno/');
    expect(buildCityHubPath('fr', 'chiasso')).toBe('/fr/trouver-emploi-tessin/chiasso/');
    expect(buildCityHubPath('en', 'locarno')).toBe('/en/find-jobs-ticino/locarno/');
    expect(buildCityHubPath('de', 'chiasso')).toBe('/de/jobs-im-tessin/chiasso/');
  });

  it('produces exactly 20 paths (5 cities × 4 locales)', () => {
    const paths = allCityHubPaths();
    expect(paths).toHaveLength(20);
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(20);
    for (const p of paths) expect(p.path.endsWith('/')).toBe(true);
  });

  it('round-trips via parseCityHubPath', () => {
    for (const p of allCityHubPaths()) {
      const parsed = parseCityHubPath(p.path);
      expect(parsed).not.toBeNull();
      expect(parsed?.locale).toBe(p.locale);
      expect(parsed?.city).toBe(p.city);
    }
  });

  it('returns null for unrelated paths', () => {
    expect(parseCityHubPath('/cerca-lavoro-ticino/')).toBeNull();
    expect(parseCityHubPath('/cerca-lavoro-ticino/software-engineer-eoc/')).toBeNull();
    expect(parseCityHubPath('/')).toBeNull();
  });
});

describe('cityJobsHub — SEO copy (F3a — CTR-optimized short titles)', () => {
  it('Italian title includes live count and city name', () => {
    const seo = buildCityHubSeo('it', 'lugano', 123, YEAR);
    expect(seo.title).toContain('Lugano');
    expect(seo.title).toContain('123');
    expect(seo.title).toContain(String(YEAR));
    // F3a: short <title> uses "Lavoro {City}" to save chars.
    expect(seo.title).toContain('Lavoro Lugano');
    // OG title and H1 retain the verbose legacy "Offerte di Lavoro" phrasing.
    expect(seo.ogT).toContain('Offerte di Lavoro');
    expect(seo.h1).toBe('123 Offerte di Lavoro a Lugano');
  });

  it('adds fire emoji to title only when count ≥ threshold', () => {
    const below = buildCityHubSeo('it', 'lugano', CITY_HUB_FIRE_THRESHOLD - 1, YEAR);
    const at = buildCityHubSeo('it', 'lugano', CITY_HUB_FIRE_THRESHOLD, YEAR);
    expect(below.title.includes('🔥')).toBe(false);
    expect(at.title.includes('🔥')).toBe(true);
  });

  it('omits count prefix entirely when count is 0', () => {
    const seo = buildCityHubSeo('it', 'mendrisio', 0, YEAR);
    expect(seo.title).not.toContain('🔥');
    expect(seo.title).not.toMatch(/— \d/);
    expect(seo.h1).toBe('Offerte di Lavoro a Mendrisio');
  });

  it('produces locale-appropriate copy for EN/DE/FR', () => {
    const en = buildCityHubSeo('en', 'lugano', 50, YEAR);
    expect(en.title).toContain('Jobs in Lugano');
    expect(en.ogT).toContain('Updated Daily');

    const de = buildCityHubSeo('de', 'bellinzona', 50, YEAR);
    expect(de.title).toContain('Bellinzona');
    expect(de.ogT).toContain('Täglich Aktualisiert');

    const fr = buildCityHubSeo('fr', 'mendrisio', 50, YEAR);
    expect(fr.title).toContain('Mendrisio');
    expect(fr.ogT).toContain('Mises à Jour Quotidiennes');
  });

  it('enforces 50-60 visible-char title length for SERP safety', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const city of CITY_HUB_KEYS) {
        for (const count of [0, 1, 42, 148, 500, 2408]) {
          const seo = buildCityHubSeo(locale, city, count, YEAR);
          const visible = [...seo.title].length;
          expect(
            visible,
            `${locale}/${city} count=${count}: "${seo.title}" length=${visible}`,
          ).toBeGreaterThanOrEqual(50);
          expect(visible).toBeLessThanOrEqual(60);
        }
      }
    }
  });
});

describe('cityJobsHub — job filtering', () => {
  const baseJob = {
    description: 'A'.repeat(10) + ' ' + 'word '.repeat(60),
    expired: false,
  };

  it('matches city by substring (case-insensitive) in location or addressLocality', () => {
    expect(jobMatchesCity({ location: 'Lugano' }, 'lugano')).toBe(true);
    expect(jobMatchesCity({ location: 'LUGANO' }, 'lugano')).toBe(true);
    expect(jobMatchesCity({ location: 'Paradiso (Lugano)' }, 'lugano')).toBe(true);
    expect(jobMatchesCity({ addressLocality: 'Mendrisio' }, 'mendrisio')).toBe(true);
    expect(jobMatchesCity({ location: 'Locarno' }, 'lugano')).toBe(false);
    expect(jobMatchesCity({}, 'lugano')).toBe(false);
  });

  it('counts only non-expired jobs with ≥50 words in description', () => {
    const jobs = [
      { ...baseJob, location: 'Lugano' },
      { ...baseJob, location: 'Mendrisio' },
      { ...baseJob, location: 'Lugano', expired: true },
      { ...baseJob, location: 'Bellinzona', description: 'short' },
      { ...baseJob, location: 'Locarno' },
      { ...baseJob, location: 'Chiasso' },
    ];
    const counts = countCityJobsByLocale(jobs);
    expect(counts.it.lugano).toBe(1);
    expect(counts.it.mendrisio).toBe(1);
    expect(counts.it.bellinzona).toBe(0);
    expect(counts.it.locarno).toBe(1);
    expect(counts.it.chiasso).toBe(1);
  });

  it('handles per-locale retranslation flags', () => {
    const jobs = [
      {
        location: 'Lugano',
        description: 'word '.repeat(60),
        descriptionByLocale: { en: 'word '.repeat(60) },
        needsRetranslation: { de: true, fr: true },
      },
    ];
    const counts = countCityJobsByLocale(jobs);
    expect(counts.it.lugano).toBe(1);
    expect(counts.en.lugano).toBe(1);
    expect(counts.de.lugano).toBe(0);
    expect(counts.fr.lugano).toBe(0);
  });
});

describe('router — city hub URLs', () => {
  beforeEach(() => {
    vi.stubGlobal('history', {
      pushState: vi.fn(),
      replaceState: vi.fn(),
      state: null,
    });
    vi.stubGlobal('window', {
      ...(globalThis as any).window,
      location: { pathname: '/', search: '', hash: '' },
      history: (globalThis as any).history,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      scrollTo: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases = [
    { locale: 'it', city: 'lugano', path: '/cerca-lavoro-ticino/lugano/', editorialPrefix: 'ricerca' },
    { locale: 'it', city: 'mendrisio', path: '/cerca-lavoro-ticino/mendrisio/', editorialPrefix: 'ricerca' },
    { locale: 'it', city: 'bellinzona', path: '/cerca-lavoro-ticino/bellinzona/', editorialPrefix: 'ricerca' },
    { locale: 'en', city: 'lugano', path: '/en/find-jobs-ticino/lugano/', editorialPrefix: 'search' },
    { locale: 'en', city: 'mendrisio', path: '/en/find-jobs-ticino/mendrisio/', editorialPrefix: 'search' },
    { locale: 'en', city: 'bellinzona', path: '/en/find-jobs-ticino/bellinzona/', editorialPrefix: 'search' },
    { locale: 'de', city: 'lugano', path: '/de/jobs-im-tessin/lugano/', editorialPrefix: 'suche' },
    { locale: 'de', city: 'mendrisio', path: '/de/jobs-im-tessin/mendrisio/', editorialPrefix: 'suche' },
    { locale: 'de', city: 'bellinzona', path: '/de/jobs-im-tessin/bellinzona/', editorialPrefix: 'suche' },
    { locale: 'fr', city: 'lugano', path: '/fr/trouver-emploi-tessin/lugano/', editorialPrefix: 'recherche' },
    { locale: 'fr', city: 'mendrisio', path: '/fr/trouver-emploi-tessin/mendrisio/', editorialPrefix: 'recherche' },
    { locale: 'fr', city: 'bellinzona', path: '/fr/trouver-emploi-tessin/bellinzona/', editorialPrefix: 'recherche' },
    { locale: 'it', city: 'locarno', path: '/cerca-lavoro-ticino/locarno/', editorialPrefix: 'ricerca' },
    { locale: 'it', city: 'chiasso', path: '/cerca-lavoro-ticino/chiasso/', editorialPrefix: 'ricerca' },
    { locale: 'en', city: 'locarno', path: '/en/find-jobs-ticino/locarno/', editorialPrefix: 'search' },
    { locale: 'en', city: 'chiasso', path: '/en/find-jobs-ticino/chiasso/', editorialPrefix: 'search' },
    { locale: 'de', city: 'locarno', path: '/de/jobs-im-tessin/locarno/', editorialPrefix: 'suche' },
    { locale: 'de', city: 'chiasso', path: '/de/jobs-im-tessin/chiasso/', editorialPrefix: 'suche' },
    { locale: 'fr', city: 'locarno', path: '/fr/trouver-emploi-tessin/locarno/', editorialPrefix: 'recherche' },
    { locale: 'fr', city: 'chiasso', path: '/fr/trouver-emploi-tessin/chiasso/', editorialPrefix: 'recherche' },
  ] as const;

  for (const c of cases) {
    it(`parsePath resolves ${c.path} → jobBoardCity=${c.city}`, () => {
      const r = parsePath(c.path);
      expect(r.locale).toBe(c.locale);
      expect(r.route.activeTab).toBe('job-board');
      expect(r.route.jobBoardCity).toBe(c.city);
      expect(r.route.jobSlug).toBe(`${c.editorialPrefix}-${c.city}`);
      expect(r.notFoundPath).toBeUndefined();
    });

    it(`buildPath emits clean URL for ${c.locale}/${c.city}`, () => {
      const out = buildPath(
        { activeTab: 'job-board', jobBoardCity: c.city },
        c.locale,
      );
      expect(out).toBe(c.path);
    });
  }

  it('non-hub slugs still resolve as legacy jobSlug', () => {
    const r = parsePath('/cerca-lavoro-ticino/software-engineer-eoc/');
    expect(r.route.activeTab).toBe('job-board');
    expect(r.route.jobBoardCity).toBeUndefined();
    expect(r.route.jobSlug).toBe('software-engineer-eoc');
  });

  it('job-board landing (no sub-slug) still works', () => {
    const r = parsePath('/cerca-lavoro-ticino/');
    expect(r.route.activeTab).toBe('job-board');
    expect(r.route.jobBoardCity).toBeUndefined();
    expect(r.route.jobSlug).toBeUndefined();
  });

  it('CITY_HUB_SLUG is consistent across locales', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const city of CITY_HUB_KEYS) {
        expect(CITY_HUB_SLUG[locale][city]).toBe(city);
      }
    }
  });
});
