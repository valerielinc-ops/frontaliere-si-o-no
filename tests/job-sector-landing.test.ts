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
  it('exposes exactly 9 sector keys', () => {
    expect(SECTOR_HUB_KEYS).toEqual([
      'infermieri',
      'case-anziani',
      'educatori',
      'ingegneri',
      'autisti',
      'sviluppatori',
      'ristorazione',
      'oss',
      'logistica',
    ]);
  });

  it('builds canonical path per locale (IT)', () => {
    expect(buildSectorHubPath('it', 'infermieri')).toBe('/cerca-lavoro-ticino/infermieri/');
    expect(buildSectorHubPath('it', 'case-anziani')).toBe('/cerca-lavoro-ticino/case-anziani/');
    expect(buildSectorHubPath('it', 'educatori')).toBe('/cerca-lavoro-ticino/educatori/');
    expect(buildSectorHubPath('it', 'ingegneri')).toBe('/cerca-lavoro-ticino/ingegneri/');
    expect(buildSectorHubPath('it', 'autisti')).toBe('/cerca-lavoro-ticino/autisti/');
    expect(buildSectorHubPath('it', 'sviluppatori')).toBe('/cerca-lavoro-ticino/sviluppatori/');
    expect(buildSectorHubPath('it', 'ristorazione')).toBe('/cerca-lavoro-ticino/ristorazione/');
  });

  it('builds canonical path per locale (EN/DE/FR)', () => {
    expect(buildSectorHubPath('en', 'infermieri')).toBe('/en/find-jobs-ticino/nurses/');
    expect(buildSectorHubPath('en', 'case-anziani')).toBe('/en/find-jobs-ticino/elderly-care/');
    expect(buildSectorHubPath('en', 'educatori')).toBe('/en/find-jobs-ticino/educators/');
    expect(buildSectorHubPath('en', 'ingegneri')).toBe('/en/find-jobs-ticino/engineers/');
    expect(buildSectorHubPath('en', 'autisti')).toBe('/en/find-jobs-ticino/drivers/');
    expect(buildSectorHubPath('en', 'sviluppatori')).toBe('/en/find-jobs-ticino/developers/');
    expect(buildSectorHubPath('en', 'ristorazione')).toBe('/en/find-jobs-ticino/restaurants/');
    expect(buildSectorHubPath('de', 'infermieri')).toBe('/de/jobs-im-tessin/pflegepersonal/');
    expect(buildSectorHubPath('de', 'case-anziani')).toBe('/de/jobs-im-tessin/altenpflege/');
    expect(buildSectorHubPath('de', 'educatori')).toBe('/de/jobs-im-tessin/erzieher/');
    expect(buildSectorHubPath('de', 'ingegneri')).toBe('/de/jobs-im-tessin/ingenieure/');
    expect(buildSectorHubPath('fr', 'infermieri')).toBe('/fr/trouver-emploi-tessin/infirmiers/');
    expect(buildSectorHubPath('fr', 'case-anziani')).toBe('/fr/trouver-emploi-tessin/maisons-retraite/');
    expect(buildSectorHubPath('fr', 'educatori')).toBe('/fr/trouver-emploi-tessin/educateurs/');
    expect(buildSectorHubPath('fr', 'ristorazione')).toBe('/fr/trouver-emploi-tessin/restauration/');
  });

  it('produces exactly 36 paths (9 sectors × 4 locales)', () => {
    const paths = allSectorHubPaths();
    expect(paths).toHaveLength(36);
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(36);
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
  it('Italian title includes live count, noun, and year (Phase 3A: ≤60ch, no emoji)', () => {
    const seo = buildSectorHubSeo('it', 'infermieri', 42, YEAR);
    expect(seo.title).toContain('Infermieri');
    expect(seo.title).toContain('42');
    expect(seo.title).toContain('Ticino');
    expect(seo.title).toContain(String(YEAR));
    expect(seo.title.length).toBeLessThanOrEqual(60);
    expect(seo.title.startsWith('🔥')).toBe(false);
    expect(seo.h1).toBe('42 posti vacanti nel settore Infermieri in Ticino');
    expect(seo.h1).not.toBe(seo.title);
  });

  it('Phase 3A drops the legacy fire-emoji prefix entirely', () => {
    const below = buildSectorHubSeo('it', 'infermieri', SECTOR_HUB_FIRE_THRESHOLD - 1, YEAR);
    const at = buildSectorHubSeo('it', 'infermieri', SECTOR_HUB_FIRE_THRESHOLD, YEAR);
    expect(below.title.startsWith('🔥')).toBe(false);
    expect(at.title.startsWith('🔥')).toBe(false);
    expect(at.title.length).toBeLessThanOrEqual(60);
  });

  it('uses zero-count narrative for H1 when count = 0 (Phase 3A)', () => {
    const seo = buildSectorHubSeo('it', 'case-anziani', 0, YEAR);
    expect(seo.title).not.toContain('🔥');
    expect(seo.title).not.toMatch(/^\d/);
    expect(seo.h1).toBe('Opportunità di lavoro per case anziani in Ticino');
    expect(seo.h1).not.toBe(seo.title);
  });

  it('produces locale-appropriate copy for EN/DE/FR (Phase 3A formatter)', () => {
    const en = buildSectorHubSeo('en', 'infermieri', 10, YEAR);
    expect(en.title).toContain('Nurses Jobs');
    expect(en.title).toContain('Ticino');
    expect(en.title.length).toBeLessThanOrEqual(60);
    expect(en.h1).not.toBe(en.title);

    const de = buildSectorHubSeo('de', 'case-anziani', 10, YEAR);
    expect(de.title).toContain('Altenpflege');
    expect(de.title).toContain('Tessin');
    expect(de.title.length).toBeLessThanOrEqual(60);
    expect(de.h1).not.toBe(de.title);

    const fr = buildSectorHubSeo('fr', 'educatori', 10, YEAR);
    expect(fr.title).toContain('Éducateurs');
    expect(fr.title).toContain('Tessin');
    expect(fr.title.length).toBeLessThanOrEqual(60);
    expect(fr.h1).not.toBe(fr.title);
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

  it('matches engineer keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Ingegnere meccanico junior' }, 'ingegneri')).toBe(true);
    expect(jobMatchesSector({ title: 'Civil Engineer Ticino' }, 'ingegneri')).toBe(true);
    expect(jobMatchesSector({ title: 'Bauingenieur ETH' }, 'ingegneri')).toBe(true);
    expect(jobMatchesSector({ title: 'Ingénieur électricien' }, 'ingegneri')).toBe(true);
    expect(jobMatchesSector({ title: 'Cassiere supermercato' }, 'ingegneri')).toBe(false);
  });

  it('matches driver keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Autista camion C+E' }, 'autisti')).toBe(true);
    expect(jobMatchesSector({ title: 'Truck driver Ticino' }, 'autisti')).toBe(true);
    expect(jobMatchesSector({ title: 'Berufsfahrer Kategorie C' }, 'autisti')).toBe(true);
    expect(jobMatchesSector({ title: 'Chauffeur poids lourd' }, 'autisti')).toBe(true);
    expect(jobMatchesSector({ title: 'Software developer' }, 'autisti')).toBe(false);
  });

  it('matches software-developer keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Sviluppatore software full-stack' }, 'sviluppatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Software Engineer Backend' }, 'sviluppatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Softwareentwickler Java' }, 'sviluppatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Développeur Python senior' }, 'sviluppatori')).toBe(true);
    expect(jobMatchesSector({ title: 'Cuoco di partita' }, 'sviluppatori')).toBe(false);
  });

  it('matches restaurant/hospitality keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Cuoco partita pesce' }, 'ristorazione')).toBe(true);
    expect(jobMatchesSector({ title: 'Cameriera pizzeria' }, 'ristorazione')).toBe(true);
    expect(jobMatchesSector({ title: 'Sous chef restaurant' }, 'ristorazione')).toBe(true);
    expect(jobMatchesSector({ title: 'Koch / Köchin Hotel' }, 'ristorazione')).toBe(true);
    expect(jobMatchesSector({ title: 'Serveur cuisinier brasserie' }, 'ristorazione')).toBe(true);
    expect(jobMatchesSector({ title: 'Software developer' }, 'ristorazione')).toBe(false);
  });

  it('matches OSS (operatori socio-sanitari) keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Operatore socio-sanitario AFC' }, 'oss')).toBe(true);
    expect(jobMatchesSector({ title: 'Healthcare assistant Ticino' }, 'oss')).toBe(true);
    expect(jobMatchesSector({ title: 'Pflegeassistent EOC' }, 'oss')).toBe(true);
    expect(jobMatchesSector({ title: 'Aide-soignant a domicile' }, 'oss')).toBe(true);
    expect(jobMatchesSector({ title: 'Software engineer' }, 'oss')).toBe(false);
  });

  it('matches logistics keywords across locales', () => {
    expect(jobMatchesSector({ title: 'Logistico AFC magazzino centrale' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Magazziniere notturno' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Warehouse operator forklift' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Lagerist Schicht' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Spediteur Hauptzollamt' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Logisticien CFC' }, 'logistica')).toBe(true);
    expect(jobMatchesSector({ title: 'Cuoco partita pesce' }, 'logistica')).toBe(false);
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
    { locale: 'it', sector: 'ingegneri', path: '/cerca-lavoro-ticino/ingegneri/' },
    { locale: 'it', sector: 'autisti', path: '/cerca-lavoro-ticino/autisti/' },
    { locale: 'it', sector: 'sviluppatori', path: '/cerca-lavoro-ticino/sviluppatori/' },
    { locale: 'it', sector: 'ristorazione', path: '/cerca-lavoro-ticino/ristorazione/' },
    { locale: 'en', sector: 'infermieri', path: '/en/find-jobs-ticino/nurses/' },
    { locale: 'en', sector: 'case-anziani', path: '/en/find-jobs-ticino/elderly-care/' },
    { locale: 'en', sector: 'educatori', path: '/en/find-jobs-ticino/educators/' },
    { locale: 'en', sector: 'ingegneri', path: '/en/find-jobs-ticino/engineers/' },
    { locale: 'en', sector: 'autisti', path: '/en/find-jobs-ticino/drivers/' },
    { locale: 'en', sector: 'sviluppatori', path: '/en/find-jobs-ticino/developers/' },
    { locale: 'en', sector: 'ristorazione', path: '/en/find-jobs-ticino/restaurants/' },
    { locale: 'de', sector: 'infermieri', path: '/de/jobs-im-tessin/pflegepersonal/' },
    { locale: 'de', sector: 'case-anziani', path: '/de/jobs-im-tessin/altenpflege/' },
    { locale: 'de', sector: 'educatori', path: '/de/jobs-im-tessin/erzieher/' },
    { locale: 'de', sector: 'ingegneri', path: '/de/jobs-im-tessin/ingenieure/' },
    { locale: 'de', sector: 'autisti', path: '/de/jobs-im-tessin/fahrer/' },
    { locale: 'de', sector: 'sviluppatori', path: '/de/jobs-im-tessin/entwickler/' },
    { locale: 'de', sector: 'ristorazione', path: '/de/jobs-im-tessin/gastronomie/' },
    { locale: 'fr', sector: 'infermieri', path: '/fr/trouver-emploi-tessin/infirmiers/' },
    { locale: 'fr', sector: 'case-anziani', path: '/fr/trouver-emploi-tessin/maisons-retraite/' },
    { locale: 'fr', sector: 'educatori', path: '/fr/trouver-emploi-tessin/educateurs/' },
    { locale: 'fr', sector: 'ingegneri', path: '/fr/trouver-emploi-tessin/ingenieurs/' },
    { locale: 'fr', sector: 'autisti', path: '/fr/trouver-emploi-tessin/chauffeurs/' },
    { locale: 'fr', sector: 'sviluppatori', path: '/fr/trouver-emploi-tessin/developpeurs/' },
    { locale: 'fr', sector: 'ristorazione', path: '/fr/trouver-emploi-tessin/restauration/' },
    { locale: 'it', sector: 'oss', path: '/cerca-lavoro-ticino/operatori-socio-sanitari/' },
    { locale: 'it', sector: 'logistica', path: '/cerca-lavoro-ticino/logistica/' },
    { locale: 'en', sector: 'oss', path: '/en/find-jobs-ticino/healthcare-assistants/' },
    { locale: 'en', sector: 'logistica', path: '/en/find-jobs-ticino/logistics/' },
    { locale: 'de', sector: 'oss', path: '/de/jobs-im-tessin/pflegeassistenten/' },
    { locale: 'de', sector: 'logistica', path: '/de/jobs-im-tessin/logistik/' },
    { locale: 'fr', sector: 'oss', path: '/fr/trouver-emploi-tessin/aides-soignants/' },
    { locale: 'fr', sector: 'logistica', path: '/fr/trouver-emploi-tessin/logistique/' },
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

  it('marks sector hub routes as staticOverlay so the SPA preserves the static SEO HTML', () => {
    // Regression: without staticOverlay the lite-shell relied on a runtime
    // DOM probe of `main.seo-static-content`. If the static file was ever
    // missing (build hiccup, deploy mid-rebuild), the SPA would silently
    // fall through to a generic JobBoard listing — losing sector filtering.
    const r = parsePath('/cerca-lavoro-ticino/infermieri/');
    expect(r.route.jobBoardSector).toBe('infermieri');
    expect(r.route.staticOverlay).toBe(true);
  });

  it('city hub routes do NOT set staticOverlay (different chrome path)', () => {
    // City hubs have their own editorial slug + redirect flow, no need
    // for the staticOverlay flag — keep this test as a guard against
    // accidental cross-contamination.
    const r = parsePath('/cerca-lavoro-ticino/lugano/');
    expect(r.route.jobBoardCity).toBe('lugano');
    expect(r.route.staticOverlay).toBeFalsy();
  });
});
