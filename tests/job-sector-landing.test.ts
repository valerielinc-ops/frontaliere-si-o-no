/**
 * Tests for sector-based job hubs (Infermieri / Case Anziani / Educatori).
 *
 * Covers:
 *  - `jobSectorLanding` helper: paths, SEO copy, sector match regex, filtering.
 *  - Router integration: `parsePath` recognizes the clean sector URLs, and
 *    `buildPath` emits the clean canonical URL from `{ jobBoardSector }`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePath, buildPath } from '@/services/router';
import {
  SECTOR_HUB_KEYS,
  SECTOR_HUB_SLUG,
  allSectorHubPaths,
  buildSectorHubPath,
  buildSectorHubSeo,
  countSectorJobsByLocale,
  filterSectorJobs,
  jobMatchesSector,
  parseSectorHubPath,
  SECTOR_HUB_FIRE_THRESHOLD,
  isSectorHubSlug,
} from '../build-plugins/jobSectorLanding';

const YEAR = 2026;

describe('jobSectorLanding — paths', () => {
  it('exposes exactly 3 sector keys', () => {
    expect(SECTOR_HUB_KEYS).toEqual(['infermieri', 'case-anziani', 'educatori']);
  });

  it('builds canonical path per locale (IT)', () => {
    expect(buildSectorHubPath('it', 'infermieri')).toBe('/cerca-lavoro-ticino/infermieri/');
    expect(buildSectorHubPath('it', 'case-anziani')).toBe('/cerca-lavoro-ticino/case-anziani/');
    expect(buildSectorHubPath('it', 'educatori')).toBe('/cerca-lavoro-ticino/educatori/');
  });

  it('builds canonical path per locale (EN/DE/FR)', () => {
    expect(buildSectorHubPath('en', 'infermieri')).toBe('/en/find-jobs-ticino/nurses/');
    expect(buildSectorHubPath('en', 'case-anziani')).toBe('/en/find-jobs-ticino/elderly-care/');
    expect(buildSectorHubPath('en', 'educatori')).toBe('/en/find-jobs-ticino/educators/');
    expect(buildSectorHubPath('de', 'infermieri')).toBe('/de/jobs-im-tessin/pflegepersonal/');
    expect(buildSectorHubPath('de', 'case-anziani')).toBe('/de/jobs-im-tessin/altenpflege/');
    expect(buildSectorHubPath('de', 'educatori')).toBe('/de/jobs-im-tessin/erzieher/');
    expect(buildSectorHubPath('fr', 'infermieri')).toBe('/fr/trouver-emploi-tessin/infirmiers/');
    expect(buildSectorHubPath('fr', 'case-anziani')).toBe('/fr/trouver-emploi-tessin/maisons-retraite/');
    expect(buildSectorHubPath('fr', 'educatori')).toBe('/fr/trouver-emploi-tessin/educateurs/');
  });

  it('produces exactly 12 paths (3 sectors × 4 locales)', () => {
    const paths = allSectorHubPaths();
    expect(paths).toHaveLength(12);
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(12);
    for (const p of paths) expect(p.path.endsWith('/')).toBe(true);
  });

  it('round-trips via parseSectorHubPath', () => {
    for (const p of allSectorHubPaths()) {
      const parsed = parseSectorHubPath(p.path);
      expect(parsed).not.toBeNull();
      expect(parsed?.locale).toBe(p.locale);
      expect(parsed?.sector).toBe(p.sector);
    }
  });

  it('returns null for unrelated paths', () => {
    expect(parseSectorHubPath('/cerca-lavoro-ticino/')).toBeNull();
    expect(parseSectorHubPath('/cerca-lavoro-ticino/lugano/')).toBeNull();
    expect(parseSectorHubPath('/')).toBeNull();
  });

  it('isSectorHubSlug reverse-maps per locale', () => {
    expect(isSectorHubSlug('it', 'infermieri')).toBe('infermieri');
    expect(isSectorHubSlug('en', 'nurses')).toBe('infermieri');
    expect(isSectorHubSlug('de', 'altenpflege')).toBe('case-anziani');
    expect(isSectorHubSlug('fr', 'educateurs')).toBe('educatori');
    expect(isSectorHubSlug('it', 'lugano')).toBeNull();
  });
});

describe('jobSectorLanding — SEO copy', () => {
  it('Italian title includes live count, noun, and year', () => {
    const seo = buildSectorHubSeo('it', 'infermieri', 42, YEAR);
    expect(seo.title).toContain('Infermieri');
    expect(seo.title).toContain('42');
    expect(seo.title).toContain('Ticino');
    expect(seo.title).toContain(String(YEAR));
    expect(seo.title).toContain('Aggiornate Oggi');
    expect(seo.h1).toBe('42 Offerte di Lavoro Infermieri in Ticino');
  });

  it('adds fire emoji only at or above threshold', () => {
    const below = buildSectorHubSeo('it', 'infermieri', SECTOR_HUB_FIRE_THRESHOLD - 1, YEAR);
    const at = buildSectorHubSeo('it', 'infermieri', SECTOR_HUB_FIRE_THRESHOLD, YEAR);
    expect(below.title.startsWith('🔥')).toBe(false);
    expect(at.title.startsWith('🔥')).toBe(true);
  });

  it('omits count prefix when count = 0', () => {
    const seo = buildSectorHubSeo('it', 'case-anziani', 0, YEAR);
    expect(seo.title).not.toContain('🔥');
    expect(seo.title).not.toMatch(/^\d/);
    expect(seo.h1).toBe('Offerte di Lavoro Case Anziani in Ticino');
  });

  it('produces locale-appropriate copy for EN/DE/FR', () => {
    const en = buildSectorHubSeo('en', 'infermieri', 10, YEAR);
    expect(en.title).toContain('Nurses Jobs in Ticino');
    expect(en.title).toContain('Updated Daily');

    const de = buildSectorHubSeo('de', 'case-anziani', 10, YEAR);
    expect(de.title).toContain('Altenpflege');
    expect(de.title).toContain('Tessin');

    const fr = buildSectorHubSeo('fr', 'educatori', 10, YEAR);
    expect(fr.title).toContain('Emploi Éducateurs');
    expect(fr.title).toContain('Tessin');
  });

  it('each locale emits a non-empty FAQ list', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const sector of SECTOR_HUB_KEYS) {
        const seo = buildSectorHubSeo(locale, sector, 5, YEAR);
        expect(seo.faq.length).toBeGreaterThanOrEqual(2);
        expect(seo.intro.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('jobSectorLanding — sector match regex', () => {
  it('matches nurse-sector keywords (IT/EN/DE/FR)', () => {
    expect(jobMatchesSector({ title: 'Infermiere SSN Lugano' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Infermieri reparto emergenza' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Registered Nurse — EOC' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Pflegefachperson HF' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Infirmière diplômée' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Software Engineer' }, 'infermieri')).toBe(false);
  });

  it('matches elderly-care keywords and named homes', () => {
    expect(jobMatchesSector({ title: 'Operatore Casa Anziani Pregassona' }, 'case-anziani')).toBe(true);
    expect(jobMatchesSector({ description: 'Lavoro in casa anziani OSCAM' }, 'case-anziani')).toBe(true);
    expect(jobMatchesSector({ title: 'Pflegehelfer Altenpflege' }, 'case-anziani')).toBe(true);
    expect(jobMatchesSector({ title: 'Nursing home carer' }, 'case-anziani')).toBe(true);
    expect(jobMatchesSector({ title: 'Caissier supermarché' }, 'case-anziani')).toBe(false);
  });

  it('matches educator keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Educatore scuola infanzia' }, 'educatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Educatrice asilo nido' }, 'educatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Erzieher Kindergarten' }, 'educatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Éducateur spécialisé' }, 'educatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Truck driver' }, 'educatori')).toBe(false);
  });

  it('scans tags and category fields', () => {
    expect(jobMatchesSector({ title: 'Staff', tags: ['infermiere'], description: '' }, 'infermieri')).toBe(true);
    expect(jobMatchesSector({ title: 'Staff', category: 'Educatori sociali', description: '' }, 'educatori')).toBe(true);
  });
});

describe('jobSectorLanding — counts and filtering', () => {
  const baseDesc = 'word '.repeat(60);

  it('counts only active, sector-matching jobs per locale', () => {
    const jobs = [
      { title: 'Infermiere Lugano', description: baseDesc, location: 'Lugano' },
      { title: 'Infermiere expired', description: baseDesc, expired: true, location: 'Lugano' },
      { title: 'Educatore', description: baseDesc, location: 'Bellinzona' },
      { title: 'Casa anziani assistente', description: baseDesc, location: 'Mendrisio' },
      { title: 'Software Engineer', description: baseDesc, location: 'Lugano' },
      { title: 'Infermiere thin', description: 'short', location: 'Lugano' },
    ];
    const counts = countSectorJobsByLocale(jobs);
    expect(counts.it.infermieri).toBe(1);
    expect(counts.it['case-anziani']).toBe(1);
    expect(counts.it.educatori).toBe(1);
  });

  it('per-locale needsRetranslation excludes from that locale only', () => {
    const jobs = [
      {
        title: 'Infermiere Lugano',
        description: baseDesc,
        descriptionByLocale: { en: baseDesc },
        location: 'Lugano',
        needsRetranslation: { de: true, fr: true },
      },
    ];
    const counts = countSectorJobsByLocale(jobs);
    expect(counts.it.infermieri).toBe(1);
    expect(counts.en.infermieri).toBe(1);
    expect(counts.de.infermieri).toBe(0);
    expect(counts.fr.infermieri).toBe(0);
  });

  it('filterSectorJobs sorts by datePosted desc and caps at maxJobs', () => {
    const jobs = [
      { title: 'Infermiere A', description: baseDesc, datePosted: '2026-04-15' },
      { title: 'Infermiere B', description: baseDesc, datePosted: '2026-04-18' },
      { title: 'Infermiere C', description: baseDesc, datePosted: '2026-04-10' },
      { title: 'Software Engineer', description: baseDesc, datePosted: '2026-04-19' },
    ];
    const filtered = filterSectorJobs(jobs, 'infermieri', 'it', 50);
    expect(filtered).toHaveLength(3);
    expect(filtered[0].title).toBe('Infermiere B');
    expect(filtered[2].title).toBe('Infermiere C');

    const capped = filterSectorJobs(jobs, 'infermieri', 'it', 2);
    expect(capped).toHaveLength(2);
  });

  it('handles missing/malformed jobs gracefully', () => {
    expect(countSectorJobsByLocale([] as never[]).it.infermieri).toBe(0);
    expect(countSectorJobsByLocale(null as unknown as never[]).it.infermieri).toBe(0);
    expect(filterSectorJobs([], 'infermieri', 'it')).toEqual([]);
  });
});

describe('router — sector hub URLs', () => {
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
    { locale: 'it', sector: 'infermieri', path: '/cerca-lavoro-ticino/infermieri/' },
    { locale: 'it', sector: 'case-anziani', path: '/cerca-lavoro-ticino/case-anziani/' },
    { locale: 'it', sector: 'educatori', path: '/cerca-lavoro-ticino/educatori/' },
    { locale: 'en', sector: 'infermieri', path: '/en/find-jobs-ticino/nurses/' },
    { locale: 'en', sector: 'case-anziani', path: '/en/find-jobs-ticino/elderly-care/' },
    { locale: 'en', sector: 'educatori', path: '/en/find-jobs-ticino/educators/' },
    { locale: 'de', sector: 'infermieri', path: '/de/jobs-im-tessin/pflegepersonal/' },
    { locale: 'de', sector: 'case-anziani', path: '/de/jobs-im-tessin/altenpflege/' },
    { locale: 'de', sector: 'educatori', path: '/de/jobs-im-tessin/erzieher/' },
    { locale: 'fr', sector: 'infermieri', path: '/fr/trouver-emploi-tessin/infirmiers/' },
    { locale: 'fr', sector: 'case-anziani', path: '/fr/trouver-emploi-tessin/maisons-retraite/' },
    { locale: 'fr', sector: 'educatori', path: '/fr/trouver-emploi-tessin/educateurs/' },
  ] as const;

  for (const c of cases) {
    it(`parsePath resolves ${c.path} → jobBoardSector=${c.sector}`, () => {
      const r = parsePath(c.path);
      expect(r.locale).toBe(c.locale);
      expect(r.route.activeTab).toBe('job-board');
      expect(r.route.jobBoardSector).toBe(c.sector);
      expect(r.notFoundPath).toBeUndefined();
    });

    it(`buildPath emits clean URL for ${c.locale}/${c.sector}`, () => {
      const out = buildPath(
        { activeTab: 'job-board', jobBoardSector: c.sector },
        c.locale,
      );
      expect(out).toBe(c.path);
    });
  }

  it('does not collide with city hubs', () => {
    const r = parsePath('/cerca-lavoro-ticino/lugano/');
    expect(r.route.jobBoardSector).toBeUndefined();
    expect(r.route.jobBoardCity).toBe('lugano');
  });

  it('non-hub slugs still resolve as legacy jobSlug', () => {
    const r = parsePath('/cerca-lavoro-ticino/some-random-job/');
    expect(r.route.activeTab).toBe('job-board');
    expect(r.route.jobBoardSector).toBeUndefined();
    expect(r.route.jobBoardCity).toBeUndefined();
    expect(r.route.jobSlug).toBe('some-random-job');
  });
});
