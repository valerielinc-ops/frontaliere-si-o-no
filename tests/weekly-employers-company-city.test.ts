/**
 * Tests for F5 D-2 Expansion B — per-company × per-city weekly hub.
 *
 * Coverage:
 *   - Company-slug canonicalisation (with Lidl special-case)
 *   - Path builders (current + archive) × 4 locales × company × city
 *   - parseCompanyCityPath — round-trip & negative cases
 *   - Gate enforcement: MIN_JOBS_PER_COMPANY_IN_CITY = 3
 *   - enumerateCompanyCityPairs respects the cap
 *   - Page renderer emits JobPosting ItemList JSON-LD, ≥300 words, canonical
 *   - Generator degrades gracefully without snapshot history (no delta copy)
 *   - relatedLinks case 'weekly_employer_company_city' returns 5 valid links
 *   - No `dark:` tailwind prefixes leak into any locale
 *   - Sibling-link injection replaces the placeholder
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_COMPANY_CITY_PAGES_PER_BUILD,
  MIN_JOBS_PER_COMPANY_IN_CITY,
  WEEKLY_EMPLOYERS_COMPANY_CITY_LIST,
  WEEKLY_EMPLOYERS_LOCALES,
  buildCompanyCityArchivePath,
  buildCompanyCityCurrentPath,
  canonicalCompanySlug,
  isCompanyCityPath,
  listCompanyCityCurrentPaths,
  parseCompanyCityPath,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '../build-plugins/weeklyEmployersData';
import {
  buildCompanyCityStats,
  enumerateCompanyCityPairs,
  generateWeeklyEmployerPages,
  injectSiblingLinks,
  renderCompanyCityPage,
  type JobsSnapshot,
  type WeeklyCountableJob,
} from '../build-plugins/weeklyEmployersPlugin';
import {
  generateRelatedLinks,
  generateRelatedLinksBlock,
} from '../build-plugins/shared/relatedLinks';

// ── Fixture helpers ─────────────────────────────────────────────

function makeJob(
  overrides: Partial<WeeklyCountableJob> & { slug: string; company: string },
): WeeklyCountableJob {
  return {
    slug: overrides.slug,
    title: overrides.title || 'Posizione aperta nel reparto operations',
    company: overrides.company,
    companyKey: overrides.companyKey,
    location: overrides.location || 'Lugano',
    addressLocality: overrides.addressLocality || 'Lugano',
    postedDate: overrides.postedDate || '2026-04-18',
    expired: overrides.expired ?? false,
    description:
      overrides.description ||
      'Offerta di lavoro di prova con descrizione sufficientemente lunga per clearare il gate minimo di 50 parole richiesto dai quality gate per ogni locale. Questo testo esiste solo a fini di test automatico del pipeline di snapshot settimanale e non rappresenta una posizione reale. Aggiungiamo altre parole per sicurezza e superare il limite di parole richiesto.',
    ...overrides,
  };
}

function makeEocJobs(count: number, city = 'Lugano'): WeeklyCountableJob[] {
  return Array.from({ length: count }, (_, i) =>
    makeJob({
      slug: `eoc-${city.toLowerCase()}-${i}`,
      company: 'EOC - Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      location: city,
      addressLocality: city,
      title: `Infermiere specialista ruolo ${i + 1}`,
      salaryMin: 60000,
      salaryMax: 80000,
    }),
  );
}

// ── Constants ────────────────────────────────────────────────────

describe('weeklyEmployersData — company-city constants', () => {
  it('exposes a company-city list that EXCLUDES the regional ticino hub', () => {
    expect(WEEKLY_EMPLOYERS_COMPANY_CITY_LIST).toEqual([
      'lugano',
      'mendrisio',
      'chiasso',
      'stabio',
      'bellinzona',
      'locarno',
    ]);
    expect(WEEKLY_EMPLOYERS_COMPANY_CITY_LIST).not.toContain('ticino' as WeeklyEmployersCompanyCity);
  });

  it('hard-gates at MIN_JOBS_PER_COMPANY_IN_CITY = 3', () => {
    expect(MIN_JOBS_PER_COMPANY_IN_CITY).toBe(3);
  });

  it('caps per-build emission at MAX_COMPANY_CITY_PAGES_PER_BUILD = 1500', () => {
    expect(MAX_COMPANY_CITY_PAGES_PER_BUILD).toBe(1500);
  });
});

// ── canonicalCompanySlug ────────────────────────────────────────

describe('canonicalCompanySlug', () => {
  it('slugifies typical company names', () => {
    expect(canonicalCompanySlug('EOC - Ente Ospedaliero Cantonale')).toBe(
      'eoc-ente-ospedaliero-cantonale',
    );
    expect(canonicalCompanySlug('ABB Svizzera (sede Ticino)')).toBe(
      'abb-svizzera-sede-ticino',
    );
  });

  it('normalises diacritics to ASCII', () => {
    expect(canonicalCompanySlug('Crédit Agricole')).toBe('credit-agricole');
  });

  it('collapses Lidl variants to the canonical Lidl brandKey', () => {
    expect(canonicalCompanySlug('Lidl Schweiz AG')).toBe('lidl');
    expect(canonicalCompanySlug('LIDL Italia', 'lidl-shop')).toBe('lidl');
  });

  it('returns a sluggy non-empty string for every fixture', () => {
    const slug = canonicalCompanySlug('A&F — Test SA');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

// ── Path builders ────────────────────────────────────────────────

describe('company-city path builders', () => {
  it('IT current path matches the spec example', () => {
    expect(
      buildCompanyCityCurrentPath('it', 'lugano', 'eoc-ente-ospedaliero-cantonale'),
    ).toBe(
      '/aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
  });

  it('EN/DE/FR paths mirror locale slugs', () => {
    expect(buildCompanyCityCurrentPath('en', 'mendrisio', 'ikea')).toBe(
      '/en/companies-hiring/mendrisio/ikea/current-week/',
    );
    expect(buildCompanyCityCurrentPath('de', 'chiasso', 'galenica')).toBe(
      '/de/unternehmen-einstellen/chiasso/galenica/aktuelle-woche/',
    );
    expect(buildCompanyCityCurrentPath('fr', 'bellinzona', 'manor-ag')).toBe(
      '/fr/entreprises-recrutent/bellinzona/manor-ag/semaine-courante/',
    );
  });

  it('archive path embeds ISO week + year', () => {
    expect(
      buildCompanyCityArchivePath('it', 'lugano', 'eoc', 16, 2026),
    ).toBe('/aziende-che-assumono/lugano/eoc/settimana-16-2026/');
    expect(
      buildCompanyCityArchivePath('de', 'chiasso', 'galenica', 5, 2026),
    ).toBe('/de/unternehmen-einstellen/chiasso/galenica/woche-05-2026/');
  });
});

// ── parseCompanyCityPath ────────────────────────────────────────

describe('parseCompanyCityPath', () => {
  it('round-trips every (locale × city × current) path', () => {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      for (const city of WEEKLY_EMPLOYERS_COMPANY_CITY_LIST) {
        const path = buildCompanyCityCurrentPath(locale, city, 'eoc');
        const parsed = parseCompanyCityPath(path);
        expect(parsed).not.toBeNull();
        expect(parsed?.locale).toBe(locale);
        expect(parsed?.city).toBe(city);
        expect(parsed?.companySlug).toBe('eoc');
        expect(parsed?.variant).toBe('current');
      }
    }
  });

  it('round-trips archive paths with week + year', () => {
    const p = buildCompanyCityArchivePath('it', 'lugano', 'eoc', 16, 2026);
    const parsed = parseCompanyCityPath(p);
    expect(parsed).toEqual({
      locale: 'it',
      city: 'lugano',
      companySlug: 'eoc',
      variant: 'archive',
      weekNum: 16,
      year: 2026,
    });
  });

  it('rejects the city-only URL (3 segments after prefix)', () => {
    expect(
      parseCompanyCityPath('/aziende-che-assumono/lugano/settimana-corrente/'),
    ).toBeNull();
  });

  it('rejects URLs where the city is the regional ticino hub', () => {
    // ticino is excluded from per-company pages.
    expect(
      parseCompanyCityPath(
        '/aziende-che-assumono/ticino/eoc/settimana-corrente/',
      ),
    ).toBeNull();
  });

  it('rejects locale/prefix mismatch on archive slug', () => {
    // IT section with EN archive prefix
    expect(
      parseCompanyCityPath('/aziende-che-assumono/lugano/eoc/week-16-2026/'),
    ).toBeNull();
  });

  it('rejects malformed company-slug segments', () => {
    expect(
      parseCompanyCityPath(
        '/aziende-che-assumono/lugano/-badprefix/settimana-corrente/',
      ),
    ).toBeNull();
    expect(
      parseCompanyCityPath(
        '/aziende-che-assumono/lugano/BAD_UPPERCASE/settimana-corrente/',
      ),
    ).toBeNull();
  });

  it('is tolerant of missing trailing slash', () => {
    expect(
      parseCompanyCityPath('/aziende-che-assumono/lugano/eoc/settimana-corrente'),
    ).not.toBeNull();
  });

  it('isCompanyCityPath is the boolean form', () => {
    expect(
      isCompanyCityPath('/aziende-che-assumono/lugano/eoc/settimana-corrente/'),
    ).toBe(true);
    expect(isCompanyCityPath('/aziende-che-assumono/lugano/settimana-corrente/')).toBe(false);
  });
});

// ── listCompanyCityCurrentPaths ────────────────────────────────

describe('listCompanyCityCurrentPaths', () => {
  it('emits (locale × pair.length) paths', () => {
    const paths = listCompanyCityCurrentPaths([
      { city: 'lugano', companySlug: 'eoc' },
      { city: 'mendrisio', companySlug: 'ikea' },
    ]);
    expect(paths).toHaveLength(2 * 4);
    const unique = new Set(paths.map((p) => p.path));
    expect(unique.size).toBe(8);
  });
});

// ── Gate enforcement / aggregation ──────────────────────────────

describe('buildCompanyCityStats — gate + aggregation', () => {
  it('returns null when the company has <3 active jobs in the city', () => {
    const jobs = makeEocJobs(2, 'Lugano');
    const stats = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc-ente-ospedaliero-cantonale',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: null,
    });
    expect(stats).toBeNull();
  });

  it('returns stats when ≥3 active jobs match', () => {
    const jobs = makeEocJobs(4, 'Lugano');
    const stats = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc-ente-ospedaliero-cantonale',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: null,
    });
    expect(stats).not.toBeNull();
    expect(stats?.activeJobsCount).toBe(4);
    expect(stats?.activeJobs).toHaveLength(4);
    expect(stats?.employer).toContain('EOC');
  });

  it('computes positive delta against a previous snapshot', () => {
    const jobs = makeEocJobs(5, 'Lugano');
    const previous: JobsSnapshot = {
      week: '2026-16',
      jobs: [
        {
          slug: 'eoc-lugano-0',
          employer: 'EOC - Ente Ospedaliero Cantonale',
          employerKey: 'eoc-ente-ospedaliero-cantonale',
          city: 'Lugano',
        },
        {
          slug: 'eoc-lugano-1',
          employer: 'EOC - Ente Ospedaliero Cantonale',
          employerKey: 'eoc-ente-ospedaliero-cantonale',
          city: 'Lugano',
        },
      ],
    };
    const stats = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc-ente-ospedaliero-cantonale',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: previous,
    });
    expect(stats?.previousCount).toBe(2);
    expect(stats?.delta).toBe(3);
  });

  it('falls back to empty topRoles but still passes the gate', () => {
    const jobs = makeEocJobs(3, 'Lugano').map((j) => ({ ...j, title: '' }));
    const stats = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: null,
    });
    expect(stats).not.toBeNull();
    expect(stats?.topRoles).toHaveLength(0);
  });

  it('computes salary midpoint average when baseSalary is present', () => {
    const jobs = makeEocJobs(3, 'Lugano'); // salaryMin=60k, salaryMax=80k → midpoint=70k
    const stats = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: null,
    });
    expect(stats?.avgSalary).toBe(70000);
  });

  it('links jobs to the per-locale detail page', () => {
    const job = makeJob({
      slug: 'eoc-lugano-0',
      company: 'EOC - Ente Ospedaliero Cantonale',
      companyKey: 'eoc-ente-ospedaliero-cantonale',
      slugByLocale: {
        it: 'infermiere-eoc-lugano',
        en: 'nurse-eoc-lugano-en',
      },
    });
    const jobs = [
      job,
      makeJob({
        slug: 'eoc-lugano-1',
        company: 'EOC - Ente Ospedaliero Cantonale',
        companyKey: 'eoc-ente-ospedaliero-cantonale',
      }),
      makeJob({
        slug: 'eoc-lugano-2',
        company: 'EOC - Ente Ospedaliero Cantonale',
        companyKey: 'eoc-ente-ospedaliero-cantonale',
      }),
    ];
    const statsIt = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'it',
      jobs,
      previousSnapshot: null,
    });
    const statsEn = buildCompanyCityStats({
      city: 'lugano',
      companySlug: 'eoc',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      locale: 'en',
      jobs,
      previousSnapshot: null,
    });
    expect(statsIt?.activeJobs[0].detailPath).toBe(
      '/cerca-lavoro-ticino/infermiere-eoc-lugano/',
    );
    expect(statsEn?.activeJobs[0].detailPath).toBe(
      '/en/find-jobs-ticino/nurse-eoc-lugano-en/',
    );
  });
});

// ── enumerateCompanyCityPairs ───────────────────────────────────

describe('enumerateCompanyCityPairs', () => {
  it('returns only pairs passing the gate', () => {
    const jobs: WeeklyCountableJob[] = [
      ...makeEocJobs(4, 'Lugano'),
      ...makeEocJobs(2, 'Mendrisio'), // below gate
      makeJob({ slug: 'other-1', company: 'Beta AG', location: 'Lugano', addressLocality: 'Lugano' }),
      makeJob({ slug: 'other-2', company: 'Beta AG', location: 'Lugano', addressLocality: 'Lugano' }),
      makeJob({ slug: 'other-3', company: 'Beta AG', location: 'Lugano', addressLocality: 'Lugano' }),
    ];
    const pairs = enumerateCompanyCityPairs(jobs);
    const keys = pairs.map((p) => `${p.city}:${p.companySlug}`);
    expect(keys).toContain('lugano:eoc-ente-ospedaliero-cantonale');
    expect(keys).toContain('lugano:beta-ag');
    expect(keys).not.toContain('mendrisio:eoc-ente-ospedaliero-cantonale');
  });

  it('produces a deterministic order (city asc, active desc, slug asc)', () => {
    const jobs: WeeklyCountableJob[] = [
      ...makeEocJobs(3, 'Lugano'),
      ...makeEocJobs(3, 'Bellinzona'),
    ];
    const pairs = enumerateCompanyCityPairs(jobs);
    const cities = pairs.map((p) => p.city);
    // bellinzona alphabetically first
    expect(cities[0]).toBe('bellinzona');
  });

  it('respects the cap MAX_COMPANY_CITY_PAGES_PER_BUILD / 4 locales', () => {
    // Synthesize 400 companies × 1 city → 400 pairs → 4 locales = 1600 > 1500 cap
    const jobs: WeeklyCountableJob[] = [];
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < 3; j++) {
        jobs.push(
          makeJob({
            slug: `co-${i}-${j}`,
            company: `Company${String(i).padStart(3, '0')} SA`,
            location: 'Lugano',
            addressLocality: 'Lugano',
          }),
        );
      }
    }
    const pairs = enumerateCompanyCityPairs(jobs);
    const maxPairs = Math.floor(MAX_COMPANY_CITY_PAGES_PER_BUILD / 4);
    expect(pairs.length).toBeLessThanOrEqual(maxPairs);
  });
});

// ── Page renderer ───────────────────────────────────────────────

describe('renderCompanyCityPage', () => {
  const fixture = {
    locale: 'it' as WeeklyEmployersLocale,
    city: 'lugano' as WeeklyEmployersCompanyCity,
    companySlug: 'eoc-ente-ospedaliero-cantonale',
    variant: 'current' as const,
    weekNum: 17,
    year: 2026,
    stats: {
      city: 'lugano' as WeeklyEmployersCompanyCity,
      companySlug: 'eoc-ente-ospedaliero-cantonale',
      employer: 'EOC - Ente Ospedaliero Cantonale',
      employerKey: 'eoc-ente-ospedaliero-cantonale',
      activeJobs: [
        {
          slug: 'infermiere-eoc-lugano-0',
          title: 'Infermiere specialista reparto cardiologia',
          detailPath: '/cerca-lavoro-ticino/infermiere-eoc-lugano-0/',
          postedDate: '2026-04-18',
        },
        {
          slug: 'infermiere-eoc-lugano-1',
          title: 'Tecnico radiologia medica',
          detailPath: '/cerca-lavoro-ticino/tecnico-radiologia-eoc-lugano/',
          postedDate: '2026-04-17',
        },
        {
          slug: 'infermiere-eoc-lugano-2',
          title: 'Assistente sociale ospedaliero',
          detailPath: '/cerca-lavoro-ticino/assistente-sociale-eoc-lugano/',
          postedDate: '2026-04-16',
        },
      ],
      activeJobsCount: 4,
      delta: 2,
      previousCount: 2,
      topRoles: [
        { role: 'infermiere specialista reparto', count: 1 },
        { role: 'tecnico radiologia medica', count: 1 },
      ],
      avgSalary: 70000,
    },
    hasHistoricalDelta: true,
    canonicalPath:
      '/aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    today: new Date('2026-04-20T12:00:00Z'),
    indexable: true,
  };

  it('emits ≥300 body words for the IT sample page', () => {
    const html = renderCompanyCityPage(fixture);
    const words = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(300);
  });

  it('emits canonical self-ref, ItemList JobPosting JSON-LD + FAQ', () => {
    const html = renderCompanyCityPage(fixture);
    expect(html).toContain(`rel="canonical" href="https://frontaliereticino.ch${fixture.canonicalPath}"`);
    expect(html).toContain('"@type":"ItemList"');
    expect(html).toContain('"@type":"JobPosting"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('links each listed job to the canonical detail path', () => {
    const html = renderCompanyCityPage(fixture);
    for (const job of fixture.stats.activeJobs) {
      expect(html).toContain(`href="${job.detailPath}"`);
    }
  });

  it('links back to employer brand hub when the employerKey matches EMPLOYER_BRANDS', () => {
    const html = renderCompanyCityPage(fixture);
    // EOC has a curated brand hub at /cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/
    expect(html).toContain('/cerca-lavoro-ticino/azienda-');
  });

  it('links back to the parent F5 city hub', () => {
    const html = renderCompanyCityPage(fixture);
    expect(html).toContain('/aziende-che-assumono/lugano/settimana-corrente/');
  });

  it('uses cold-start copy when no historical delta is available', () => {
    const html = renderCompanyCityPage({ ...fixture, hasHistoricalDelta: false });
    expect(html).toMatch(/Dati iniziali/);
  });

  it('emits noindex,follow on an old archive variant', () => {
    const html = renderCompanyCityPage({
      ...fixture,
      variant: 'archive',
      indexable: false,
      canonicalPath: '/aziende-che-assumono/lugano/eoc/settimana-01-2025/',
    });
    expect(html).toContain('noindex,follow');
  });

  it('does NOT contain any dark: tailwind prefixes in any locale', () => {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      const html = renderCompanyCityPage({ ...fixture, locale });
      expect(html).not.toMatch(/\bdark:(bg|text|border|ring)-/);
    }
  });

  it('emits hreflang alternates across the 4 locales + x-default', () => {
    const html = renderCompanyCityPage(fixture);
    for (const alt of WEEKLY_EMPLOYERS_LOCALES) {
      expect(html).toContain(`hreflang="${alt}"`);
    }
    expect(html).toContain('hreflang="x-default"');
  });

  it('injects sibling links when siblings are provided', () => {
    const html = renderCompanyCityPage(fixture);
    const withSiblings = injectSiblingLinks(
      html,
      'it',
      'eoc-ente-ospedaliero-cantonale',
      'lugano',
      ['lugano', 'bellinzona', 'mendrisio'],
      'EOC - Ente Ospedaliero Cantonale',
    );
    expect(withSiblings).toContain(
      '/aziende-che-assumono/bellinzona/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
    expect(withSiblings).toContain(
      '/aziende-che-assumono/mendrisio/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
    // No placeholder comment remains
    expect(withSiblings).not.toContain('SIBLING_LINKS_PLACEHOLDER');
  });

  it('cleanly removes the placeholder when no siblings exist', () => {
    const html = renderCompanyCityPage(fixture);
    const cleaned = injectSiblingLinks(
      html,
      'it',
      'solo-company',
      'lugano',
      [],
      'Solo Company',
    );
    expect(cleaned).not.toContain('SIBLING_LINKS_PLACEHOLDER');
  });
});

// ── Generator integration ──────────────────────────────────────

describe('generateWeeklyEmployerPages — company-city integration', () => {
  it('emits 4 locales × qualifying pairs in degraded mode (no snapshots)', () => {
    const jobs: WeeklyCountableJob[] = [
      ...makeEocJobs(4, 'Lugano'), // qualifies
      ...makeEocJobs(3, 'Bellinzona'), // qualifies
      // Beta AG only in Mendrisio with 5 → qualifies
      makeJob({ slug: 'beta-1', company: 'Beta AG', location: 'Mendrisio', addressLocality: 'Mendrisio' }),
      makeJob({ slug: 'beta-2', company: 'Beta AG', location: 'Mendrisio', addressLocality: 'Mendrisio' }),
      makeJob({ slug: 'beta-3', company: 'Beta AG', location: 'Mendrisio', addressLocality: 'Mendrisio' }),
      makeJob({ slug: 'beta-4', company: 'Beta AG', location: 'Mendrisio', addressLocality: 'Mendrisio' }),
      // Gamma SA has only 2 jobs → gated out
      makeJob({ slug: 'gamma-1', company: 'Gamma SA', location: 'Chiasso', addressLocality: 'Chiasso' }),
      makeJob({ slug: 'gamma-2', company: 'Gamma SA', location: 'Chiasso', addressLocality: 'Chiasso' }),
    ];
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });

    const companyCityPages = pages.filter(
      (p) => parseCompanyCityPath(p.path) !== null,
    );
    // 3 qualifying pairs × 4 locales = 12
    expect(companyCityPages).toHaveLength(3 * 4);

    // Gamma SA must NOT appear
    const gammaPages = pages.filter((p) => p.path.includes('gamma'));
    expect(gammaPages).toHaveLength(0);
  });

  it('each generated company-city page is indexable and ≥300 words in degraded mode', () => {
    const jobs = makeEocJobs(5, 'Lugano');
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const companyCityPages = pages.filter(
      (p) => parseCompanyCityPath(p.path) !== null,
    );
    expect(companyCityPages.length).toBeGreaterThan(0);
    for (const p of companyCityPages) {
      expect(p.indexable).toBe(true);
      const words = p.html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(300);
    }
  });

  it('each page has unique canonical path (no duplicates)', () => {
    const jobs = makeEocJobs(5, 'Lugano');
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const companyCityPages = pages.filter(
      (p) => parseCompanyCityPath(p.path) !== null,
    );
    const paths = companyCityPages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does NOT emit regional ticino company-city pages', () => {
    const jobs = makeEocJobs(5, 'Lugano');
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });
    // All per-company pages should be under city-not-ticino segments.
    for (const p of pages) {
      const parsed = parseCompanyCityPath(p.path);
      if (parsed) {
        expect(parsed.city).not.toBe('ticino' as never);
      }
    }
  });

  it('injects sibling links when same company qualifies in multiple cities', () => {
    const jobs: WeeklyCountableJob[] = [
      ...makeEocJobs(4, 'Lugano'),
      ...makeEocJobs(3, 'Bellinzona'),
      ...makeEocJobs(3, 'Mendrisio'),
    ];
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const luganoIt = pages.find(
      (p) =>
        p.path ===
        '/aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
    expect(luganoIt).toBeTruthy();
    // Links to sibling cities for the SAME company should be present.
    expect(luganoIt?.html).toContain(
      '/aziende-che-assumono/bellinzona/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
    expect(luganoIt?.html).toContain(
      '/aziende-che-assumono/mendrisio/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
  });

  it('computes delta against the latest snapshot when ≥1 snapshot exists', () => {
    const jobs = makeEocJobs(5, 'Lugano');
    const snapshots: JobsSnapshot[] = [
      {
        week: '2026-16',
        jobs: [
          {
            slug: 'eoc-lugano-old-0',
            employer: 'EOC - Ente Ospedaliero Cantonale',
            employerKey: 'eoc-ente-ospedaliero-cantonale',
            city: 'Lugano',
          },
          {
            slug: 'eoc-lugano-old-1',
            employer: 'EOC - Ente Ospedaliero Cantonale',
            employerKey: 'eoc-ente-ospedaliero-cantonale',
            city: 'Lugano',
          },
        ],
      },
      {
        week: '2026-17',
        jobs: jobs.map((j) => ({
          slug: j.slug!,
          employer: j.company!,
          employerKey: j.companyKey,
          city: 'Lugano',
        })),
      },
    ];
    const pages = generateWeeklyEmployerPages({
      rootDir: process.cwd(),
      jobs,
      snapshots,
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const luganoIt = pages.find(
      (p) =>
        p.path ===
        '/aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/',
    );
    expect(luganoIt).toBeTruthy();
    // With delta=3, the IT hero block says "+3" (5 this week - 2 previous).
    expect(luganoIt?.html).toMatch(/\+3/);
  });
});

// ── relatedLinks case coverage ─────────────────────────────────

describe("relatedLinks — case 'weekly_employer_company_city'", () => {
  it('returns exactly 5 links for every locale', () => {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      const links = generateRelatedLinks(locale, 'weekly_employer_company_city', {
        city: 'lugano',
        weeklyCity: 'lugano',
        companySlug: 'eoc-ente-ospedaliero-cantonale',
        employer: 'EOC - Ente Ospedaliero Cantonale',
      });
      expect(links).toHaveLength(5);
      for (const link of links) {
        expect(link.href.length).toBeGreaterThan(0);
        expect(link.title.length).toBeGreaterThan(0);
        expect(link.href.startsWith('/')).toBe(true);
      }
    }
  });

  it('includes a link back to the parent F5 city hub', () => {
    const links = generateRelatedLinks('it', 'weekly_employer_company_city', {
      city: 'lugano',
      weeklyCity: 'lugano',
      companySlug: 'eoc',
    });
    const hrefs = links.map((l) => l.href);
    expect(
      hrefs.some((h) => h === '/aziende-che-assumono/lugano/settimana-corrente/'),
    ).toBe(true);
  });

  it('includes a sibling-city company-city link when companySlug is valid', () => {
    const links = generateRelatedLinks('it', 'weekly_employer_company_city', {
      city: 'lugano',
      weeklyCity: 'lugano',
      companySlug: 'eoc',
    });
    const hrefs = links.map((l) => l.href);
    expect(
      hrefs.some((h) => /\/aziende-che-assumono\/(?!lugano)[^/]+\/eoc\/settimana-corrente\//.test(h)),
    ).toBe(true);
  });

  it('renders an HTML <nav> block with 5 anchors', () => {
    const html = generateRelatedLinksBlock('it', 'weekly_employer_company_city', {
      city: 'lugano',
      weeklyCity: 'lugano',
      companySlug: 'eoc',
    });
    expect(html).toContain('<nav');
    const anchorCount = (html.match(/<a /g) || []).length;
    expect(anchorCount).toBe(5);
    expect(html).not.toMatch(/\bdark:(bg|text|border|ring)-/);
  });
});
