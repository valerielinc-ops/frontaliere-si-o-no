/**
 * Tests for F5 — Weekly "Aziende che assumono" per-city Hub.
 *
 * Coverage:
 *   - Path builders (current + archive) for all 4 locales × 7 cities.
 *   - Route enumeration (WEEKLY_EMPLOYERS_ROUTES = 28 paths).
 *   - Path parser — round-trip for current + archive URLs.
 *   - ISO-week helpers (year boundaries).
 *   - Delta computation from a pair of synthetic snapshots.
 *   - Page generator — all 4 locales present, ≥300 words, JSON-LD, canonical.
 *   - Degraded mode (no snapshot history) still generates current-week pages.
 *   - Translation chunks: all 4 locales have the same keys (locale completeness).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEEKLY_EMPLOYERS_ARCHIVE_PREFIX,
  WEEKLY_EMPLOYERS_CITIES,
  WEEKLY_EMPLOYERS_CITY_DISPLAY,
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_INDEXABLE_WEEKS,
  WEEKLY_EMPLOYERS_LOCALES,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_ROUTES,
  WEEKLY_EMPLOYERS_SECTION,
  buildArchiveSlug,
  buildArchiveWeekPath,
  buildCurrentWeekPath,
  getIsoWeekAndYear,
  isWeeklyEmployersPath,
  isoWeekKey,
  listCurrentWeekPaths,
  parseWeeklyEmployersPath,
  type WeeklyEmployersCity,
  type WeeklyEmployersLocale,
} from '../build-plugins/weeklyEmployersData';
import {
  buildCityWeeklyStats,
  generateWeeklyEmployerPages,
  jobMatchesCity,
  renderWeeklyEmployersPage,
  type JobsSnapshot,
  type WeeklyCountableJob,
} from '../build-plugins/weeklyEmployersPlugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Constants / slug tables ──────────────────────────────────

describe('weeklyEmployersData — constants', () => {
  it('exposes exactly 4 locales', () => {
    expect(WEEKLY_EMPLOYERS_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('exposes 7 cities: regional ticino + 6 priority cities', () => {
    expect(WEEKLY_EMPLOYERS_CITIES).toEqual([
      'ticino',
      'lugano',
      'mendrisio',
      'chiasso',
      'stabio',
      'bellinzona',
      'locarno',
    ]);
  });

  it('has a display name for every city', () => {
    for (const city of WEEKLY_EMPLOYERS_CITIES) {
      expect(WEEKLY_EMPLOYERS_CITY_DISPLAY[city]).toBeTruthy();
    }
  });

  it('exposes the expected IT/EN/DE/FR section slugs', () => {
    expect(WEEKLY_EMPLOYERS_SECTION.it).toBe('aziende-che-assumono');
    expect(WEEKLY_EMPLOYERS_SECTION.en).toBe('companies-hiring');
    expect(WEEKLY_EMPLOYERS_SECTION.de).toBe('unternehmen-einstellen');
    expect(WEEKLY_EMPLOYERS_SECTION.fr).toBe('entreprises-recrutent');
  });

  it('exposes the expected current-week slug per locale', () => {
    expect(WEEKLY_EMPLOYERS_CURRENT_SLUG.it).toBe('settimana-corrente');
    expect(WEEKLY_EMPLOYERS_CURRENT_SLUG.en).toBe('current-week');
    expect(WEEKLY_EMPLOYERS_CURRENT_SLUG.de).toBe('aktuelle-woche');
    expect(WEEKLY_EMPLOYERS_CURRENT_SLUG.fr).toBe('semaine-courante');
  });

  it('exposes the expected archive prefix per locale', () => {
    expect(WEEKLY_EMPLOYERS_ARCHIVE_PREFIX.it).toBe('settimana');
    expect(WEEKLY_EMPLOYERS_ARCHIVE_PREFIX.en).toBe('week');
    expect(WEEKLY_EMPLOYERS_ARCHIVE_PREFIX.de).toBe('woche');
    expect(WEEKLY_EMPLOYERS_ARCHIVE_PREFIX.fr).toBe('semaine');
  });

  it('caps indexable archive weeks at 12', () => {
    expect(WEEKLY_EMPLOYERS_INDEXABLE_WEEKS).toBe(12);
  });
});

// ── Path builders ────────────────────────────────────────────

describe('weeklyEmployersData — path builders', () => {
  it('builds IT current-week paths with no locale prefix', () => {
    expect(buildCurrentWeekPath('it', 'ticino')).toBe(
      '/aziende-che-assumono/ticino/settimana-corrente/',
    );
    expect(buildCurrentWeekPath('it', 'lugano')).toBe(
      '/aziende-che-assumono/lugano/settimana-corrente/',
    );
    expect(buildCurrentWeekPath('it', 'stabio')).toBe(
      '/aziende-che-assumono/stabio/settimana-corrente/',
    );
  });

  it('builds EN / DE / FR current-week paths with locale prefix', () => {
    expect(buildCurrentWeekPath('en', 'mendrisio')).toBe(
      '/en/companies-hiring/mendrisio/current-week/',
    );
    expect(buildCurrentWeekPath('de', 'chiasso')).toBe(
      '/de/unternehmen-einstellen/chiasso/aktuelle-woche/',
    );
    expect(buildCurrentWeekPath('fr', 'ticino')).toBe(
      '/fr/entreprises-recrutent/ticino/semaine-courante/',
    );
  });

  it('builds archive paths with ISO week + year', () => {
    expect(buildArchiveSlug('it', 16, 2026)).toBe('settimana-16-2026');
    expect(buildArchiveSlug('en', 16, 2026)).toBe('week-16-2026');
    expect(buildArchiveSlug('de', 5, 2026)).toBe('woche-05-2026');
    expect(buildArchiveSlug('fr', 53, 2025)).toBe('semaine-53-2025');

    expect(buildArchiveWeekPath('it', 'lugano', 16, 2026)).toBe(
      '/aziende-che-assumono/lugano/settimana-16-2026/',
    );
    expect(buildArchiveWeekPath('en', 'mendrisio', 16, 2026)).toBe(
      '/en/companies-hiring/mendrisio/week-16-2026/',
    );
    expect(buildArchiveWeekPath('de', 'chiasso', 5, 2026)).toBe(
      '/de/unternehmen-einstellen/chiasso/woche-05-2026/',
    );
    expect(buildArchiveWeekPath('fr', 'ticino', 53, 2025)).toBe(
      '/fr/entreprises-recrutent/ticino/semaine-53-2025/',
    );
  });

  it('WEEKLY_EMPLOYERS_ROUTES has 4×7=28 unique current-week paths', () => {
    expect(WEEKLY_EMPLOYERS_ROUTES).toHaveLength(28);
    expect(new Set(WEEKLY_EMPLOYERS_ROUTES).size).toBe(28);
    for (const p of WEEKLY_EMPLOYERS_ROUTES) {
      expect(p.endsWith('/')).toBe(true);
      expect(p.startsWith('/')).toBe(true);
    }
  });

  it('listCurrentWeekPaths mirrors WEEKLY_EMPLOYERS_ROUTES', () => {
    const paths = listCurrentWeekPaths();
    expect(paths).toHaveLength(28);
    expect(paths.map((p) => p.path).sort()).toEqual(
      [...WEEKLY_EMPLOYERS_ROUTES].sort(),
    );
  });
});

// ── Path parser ─────────────────────────────────────────────

describe('weeklyEmployersData — parseWeeklyEmployersPath', () => {
  it('round-trips every current-week URL', () => {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      for (const city of WEEKLY_EMPLOYERS_CITIES) {
        const p = buildCurrentWeekPath(locale, city);
        const parsed = parseWeeklyEmployersPath(p);
        expect(parsed).not.toBeNull();
        expect(parsed?.locale).toBe(locale);
        expect(parsed?.city).toBe(city);
        expect(parsed?.variant).toBe('current');
      }
    }
  });

  it('parses archive URLs (IT/EN/DE/FR)', () => {
    expect(parseWeeklyEmployersPath('/aziende-che-assumono/lugano/settimana-16-2026/')).toEqual({
      locale: 'it',
      city: 'lugano',
      variant: 'archive',
      weekNum: 16,
      year: 2026,
    });
    expect(parseWeeklyEmployersPath('/en/companies-hiring/mendrisio/week-42-2025/')).toEqual({
      locale: 'en',
      city: 'mendrisio',
      variant: 'archive',
      weekNum: 42,
      year: 2025,
    });
    expect(parseWeeklyEmployersPath('/de/unternehmen-einstellen/chiasso/woche-05-2026/')).toEqual({
      locale: 'de',
      city: 'chiasso',
      variant: 'archive',
      weekNum: 5,
      year: 2026,
    });
    expect(parseWeeklyEmployersPath('/fr/entreprises-recrutent/ticino/semaine-53-2025/')).toEqual({
      locale: 'fr',
      city: 'ticino',
      variant: 'archive',
      weekNum: 53,
      year: 2025,
    });
  });

  it('rejects URLs outside the section or with unknown city', () => {
    expect(parseWeeklyEmployersPath('/comparatori/cambio-valuta/')).toBeNull();
    expect(parseWeeklyEmployersPath('/aziende-che-assumono/foo/settimana-corrente/')).toBeNull();
    expect(parseWeeklyEmployersPath('/aziende-che-assumono/lugano/fake-slug/')).toBeNull();
    expect(parseWeeklyEmployersPath('')).toBeNull();
  });

  it('rejects locale mismatch against archive slug prefix', () => {
    // IT section with EN archive prefix should not match
    expect(
      parseWeeklyEmployersPath('/aziende-che-assumono/lugano/week-16-2026/'),
    ).toBeNull();
    // EN section with IT prefix
    expect(
      parseWeeklyEmployersPath('/en/companies-hiring/mendrisio/settimana-16-2026/'),
    ).toBeNull();
  });

  it('isWeeklyEmployersPath is the boolean form of the parser', () => {
    expect(isWeeklyEmployersPath('/aziende-che-assumono/ticino/settimana-corrente/')).toBe(true);
    expect(isWeeklyEmployersPath('/aziende-che-assumono/lugano/settimana-16-2026/')).toBe(true);
    expect(isWeeklyEmployersPath('/comparatori/cambio-valuta/')).toBe(false);
  });

  it('is tolerant of missing trailing slash', () => {
    expect(
      parseWeeklyEmployersPath('/aziende-che-assumono/ticino/settimana-corrente'),
    ).not.toBeNull();
    expect(parseWeeklyEmployersPath('/en/companies-hiring/lugano/current-week')).not.toBeNull();
  });
});

// ── ISO-week helpers ─────────────────────────────────────────

describe('weeklyEmployersData — ISO week helpers', () => {
  it('computes ISO week for a reference date mid-year', () => {
    // 2026-04-20 is a Monday → ISO week 17 of 2026
    const d = new Date('2026-04-20T12:00:00Z');
    expect(getIsoWeekAndYear(d)).toEqual({ week: 17, year: 2026 });
    expect(isoWeekKey(d)).toBe('2026-17');
  });

  it('handles ISO-week year boundary (2026-01-01 → week 1 of 2026)', () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026
    const d = new Date('2026-01-01T12:00:00Z');
    expect(getIsoWeekAndYear(d)).toEqual({ week: 1, year: 2026 });
  });

  it('handles the other boundary (2021-01-01 → week 53 of 2020)', () => {
    // Friday 2021-01-01 belongs to ISO week 53 of 2020
    const d = new Date('2021-01-01T12:00:00Z');
    expect(getIsoWeekAndYear(d)).toEqual({ week: 53, year: 2020 });
  });
});

// ── jobMatchesCity / buildCityWeeklyStats ────────────────────

function makeJob(overrides: Partial<WeeklyCountableJob>): WeeklyCountableJob {
  return {
    slug: overrides.slug || 'job-slug',
    title: overrides.title || 'Titolo della posizione aperta',
    company: overrides.company || 'Acme SA',
    companyKey: overrides.companyKey,
    location: overrides.location || 'Lugano',
    addressLocality: overrides.addressLocality || 'Lugano',
    postedDate: overrides.postedDate || '2026-04-18',
    expired: overrides.expired ?? false,
    description:
      overrides.description ||
      // 60-word description so jobIsActive() clears the 50-word gate for IT (default)
      'Offerta di lavoro di prova con descrizione sufficientemente lunga per clearare il gate minimo di 50 parole richiesto dai quality gate per ogni locale. Questo testo esiste solo a fini di test automatico del pipeline di snapshot settimanale e non rappresenta una posizione reale. Aggiungiamo altre parole per sicurezza e superare il limite di parole.',
    descriptionByLocale: overrides.descriptionByLocale,
    titleByLocale: overrides.titleByLocale,
    ...overrides,
  };
}

describe('buildCityWeeklyStats', () => {
  it('jobMatchesCity handles ticino (all), specific cities and negatives', () => {
    const j = makeJob({ location: 'Mendrisio', addressLocality: 'Mendrisio' });
    expect(jobMatchesCity(j, 'ticino')).toBe(true);
    expect(jobMatchesCity(j, 'mendrisio')).toBe(true);
    expect(jobMatchesCity(j, 'lugano')).toBe(false);
    // case-insensitivity and substring match
    const j2 = makeJob({ location: 'LUGANO-Paradiso', addressLocality: 'Paradiso (Lugano)' });
    expect(jobMatchesCity(j2, 'lugano')).toBe(true);
  });

  it('computes positive delta when current snapshot has more employer hires', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ slug: 'a-1', company: 'Acme SA', companyKey: 'acme' }),
      makeJob({ slug: 'a-2', company: 'Acme SA', companyKey: 'acme' }),
      makeJob({ slug: 'a-3', company: 'Acme SA', companyKey: 'acme' }),
      makeJob({ slug: 'b-1', company: 'Beta AG', companyKey: 'beta' }),
    ];
    const previous: JobsSnapshot = {
      week: '2026-16',
      jobs: [
        { slug: 'a-1', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' },
        { slug: 'b-1', employer: 'Beta AG', employerKey: 'beta', city: 'Lugano' },
      ],
    };
    const stats = buildCityWeeklyStats({
      city: 'lugano',
      locale: 'it',
      jobs,
      previousSnapshot: previous,
      historicalSnapshots: [],
    });
    expect(stats.activeJobsCount).toBe(4);
    // Acme has +2 this week; Beta has +0. Ranked by delta desc → Acme first.
    expect(stats.topCompanies[0].employer).toBe('Acme SA');
    expect(stats.topCompanies[0].delta).toBe(2);
    expect(stats.topCompanies[1].employer).toBe('Beta AG');
    expect(stats.topCompanies[1].delta).toBe(0);
  });

  it('flags newcomers as employers absent from historical + previous snapshots', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ slug: 'a-1', company: 'Acme SA', companyKey: 'acme' }),
      makeJob({ slug: 'n-1', company: 'Novex LLC', companyKey: 'novex' }),
    ];
    const previous: JobsSnapshot = {
      week: '2026-16',
      jobs: [{ slug: 'a-1', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' }],
    };
    const older: JobsSnapshot = {
      week: '2026-15',
      jobs: [{ slug: 'a-1', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' }],
    };
    const stats = buildCityWeeklyStats({
      city: 'lugano',
      locale: 'it',
      jobs,
      previousSnapshot: previous,
      historicalSnapshots: [older],
    });
    const newcomerNames = stats.newcomers.map((n) => n.employer);
    expect(newcomerNames).toContain('Novex LLC');
    expect(newcomerNames).not.toContain('Acme SA');
  });

  it('produces an empty-but-valid result when no jobs match the city', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ location: 'Lugano', addressLocality: 'Lugano' }),
    ];
    const stats = buildCityWeeklyStats({
      city: 'stabio',
      locale: 'it',
      jobs,
      previousSnapshot: null,
      historicalSnapshots: [],
    });
    expect(stats.activeJobsCount).toBe(0);
    expect(stats.topCompanies).toHaveLength(0);
  });
});

// ── Page renderer ───────────────────────────────────────────

describe('renderWeeklyEmployersPage', () => {
  it('produces ≥300 words for the IT Lugano current-week page', () => {
    const stats = {
      city: 'lugano' as WeeklyEmployersCity,
      activeJobsCount: 12,
      topCompanies: [
        { employer: 'Acme SA', employerKey: 'acme', active: 6, delta: 3 },
        { employer: 'Beta AG', employerKey: 'beta', active: 3, delta: 1 },
        { employer: 'Gamma Srl', employerKey: 'gamma', active: 3, delta: 0 },
      ],
      newcomers: [{ employer: 'Novex LLC', employerKey: 'novex', active: 2 }],
      topRoles: [
        { role: 'sviluppatore software', count: 4 },
        { role: 'cassiere magazzino', count: 2 },
      ],
    };
    const html = renderWeeklyEmployersPage({
      locale: 'it',
      city: 'lugano',
      variant: 'current',
      weekNum: 17,
      year: 2026,
      stats,
      hasHistoricalDelta: true,
      canonicalPath: buildCurrentWeekPath('it', 'lugano'),
      today: new Date('2026-04-20T12:00:00Z'),
      indexable: true,
    });
    // Strip tags and count words (same logic as constants.countHtmlBodyWords).
    const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(300);
    expect(html).toContain('<title>');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"ItemList"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"@type":"FAQPage"');
  });

  it('uses cold-start copy when no historical delta is available', () => {
    const stats = {
      city: 'stabio' as WeeklyEmployersCity,
      activeJobsCount: 4,
      topCompanies: [{ employer: 'Foo SA', employerKey: 'foo', active: 4, delta: 0 }],
      newcomers: [],
      topRoles: [],
    };
    const html = renderWeeklyEmployersPage({
      locale: 'it',
      city: 'stabio',
      variant: 'current',
      weekNum: 17,
      year: 2026,
      stats,
      hasHistoricalDelta: false,
      canonicalPath: buildCurrentWeekPath('it', 'stabio'),
      today: new Date('2026-04-20T12:00:00Z'),
      indexable: true,
    });
    expect(html).toMatch(/Dati iniziali/);
    expect(html).toContain('index,follow');
  });

  it('emits noindex,follow on old archive pages', () => {
    const stats = {
      city: 'chiasso' as WeeklyEmployersCity,
      activeJobsCount: 3,
      topCompanies: [{ employer: 'Acme SA', employerKey: 'acme', active: 3, delta: 2 }],
      newcomers: [],
      topRoles: [],
    };
    const html = renderWeeklyEmployersPage({
      locale: 'it',
      city: 'chiasso',
      variant: 'archive',
      weekNum: 1,
      year: 2025,
      stats,
      hasHistoricalDelta: true,
      canonicalPath: buildArchiveWeekPath('it', 'chiasso', 1, 2025),
      today: new Date('2026-04-20T12:00:00Z'),
      indexable: false,
    });
    expect(html).toContain('noindex,follow');
  });

  it('does NOT contain any dark: tailwind prefixes', () => {
    const stats = {
      city: 'lugano' as WeeklyEmployersCity,
      activeJobsCount: 2,
      topCompanies: [{ employer: 'Acme SA', employerKey: 'acme', active: 2, delta: 1 }],
      newcomers: [],
      topRoles: [],
    };
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      const html = renderWeeklyEmployersPage({
        locale,
        city: 'lugano',
        variant: 'current',
        weekNum: 17,
        year: 2026,
        stats,
        hasHistoricalDelta: true,
        canonicalPath: buildCurrentWeekPath(locale, 'lugano'),
        today: new Date('2026-04-20T12:00:00Z'),
        indexable: true,
      });
      expect(html).not.toMatch(/\bdark:(bg|text|border|ring)-/);
    }
  });

  it('emits canonical self-referent + hreflang alternates for the 4 locales', () => {
    const stats = {
      city: 'lugano' as WeeklyEmployersCity,
      activeJobsCount: 2,
      topCompanies: [{ employer: 'Acme SA', employerKey: 'acme', active: 2, delta: 1 }],
      newcomers: [],
      topRoles: [],
    };
    const path = buildCurrentWeekPath('en', 'lugano');
    const html = renderWeeklyEmployersPage({
      locale: 'en',
      city: 'lugano',
      variant: 'current',
      weekNum: 17,
      year: 2026,
      stats,
      hasHistoricalDelta: true,
      canonicalPath: path,
      today: new Date('2026-04-20T12:00:00Z'),
      indexable: true,
    });
    expect(html).toContain(`rel="canonical" href="https://frontaliereticino.ch${path}"`);
    for (const alt of WEEKLY_EMPLOYERS_LOCALES) {
      expect(html).toContain(`hreflang="${alt}"`);
    }
    expect(html).toContain('hreflang="x-default"');
  });
});

// ── generateWeeklyEmployerPages ─────────────────────────────

describe('generateWeeklyEmployerPages', () => {
  it('emits 28 current-week pages in degraded mode (no snapshots)', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ slug: 'a-1', company: 'Acme SA', location: 'Lugano', addressLocality: 'Lugano' }),
      makeJob({ slug: 'a-2', company: 'Acme SA', location: 'Lugano', addressLocality: 'Lugano' }),
      makeJob({ slug: 'b-1', company: 'Beta AG', location: 'Mendrisio', addressLocality: 'Mendrisio' }),
      makeJob({ slug: 'c-1', company: 'Gamma Srl', location: 'Stabio', addressLocality: 'Stabio' }),
    ];
    const pages = generateWeeklyEmployerPages({
      rootDir: ROOT,
      jobs,
      snapshots: [],
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const current = pages.filter((p) => p.path.includes('settimana-corrente') || p.path.includes('current-week') || p.path.includes('aktuelle-woche') || p.path.includes('semaine-courante'));
    expect(current).toHaveLength(28);
    // No archive pages in degraded mode
    const archive = pages.filter((p) => /\/(?:settimana|week|woche|semaine)-\d{2}-\d{4}\//.test(p.path));
    expect(archive).toHaveLength(0);
  });

  it('emits archive pages when ≥2 snapshots exist', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ slug: 'a-1', company: 'Acme SA', location: 'Lugano', addressLocality: 'Lugano' }),
    ];
    const snapshots: JobsSnapshot[] = [
      {
        week: '2026-15',
        jobs: [{ slug: 'a-1', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' }],
      },
      {
        week: '2026-16',
        jobs: [
          { slug: 'a-1', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' },
          { slug: 'a-2', employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' },
        ],
      },
    ];
    const pages = generateWeeklyEmployerPages({
      rootDir: ROOT,
      jobs,
      snapshots,
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const archive = pages.filter((p) => /\/(?:settimana|week|woche|semaine)-\d{2}-\d{4}\//.test(p.path));
    // 2 snapshot weeks × 4 locales × 7 cities = 56 archive pages
    expect(archive.length).toBe(2 * 4 * 7);
    // All archive pages for snapshots ≤12 weeks ago must be indexable
    for (const p of archive) {
      expect(p.indexable).toBe(true);
    }
  });

  it('marks older archives (>12 weeks back in sorted list) as noindex', () => {
    const jobs: WeeklyCountableJob[] = [
      makeJob({ slug: 'a-1', company: 'Acme SA', location: 'Lugano', addressLocality: 'Lugano' }),
    ];
    // Build 15 consecutive weekly snapshots
    const snapshots: JobsSnapshot[] = Array.from({ length: 15 }, (_, i) => ({
      week: `2026-${String(i + 2).padStart(2, '0')}`,
      jobs: [{ slug: `a-${i}`, employer: 'Acme SA', employerKey: 'acme', city: 'Lugano' }],
    }));
    const pages = generateWeeklyEmployerPages({
      rootDir: ROOT,
      jobs,
      snapshots,
      today: new Date('2026-04-20T12:00:00Z'),
    });
    const archive = pages.filter((p) => /\/(?:settimana|week|woche|semaine)-\d{2}-\d{4}\//.test(p.path));
    // 15 snapshots × 4 locales × 7 cities. 12 most recent weeks → indexable,
    // 3 oldest → noindex. Current week (2026-17) is skipped if present, but
    // our fixtures only cover weeks 2-16 so all are archives.
    const indexable = archive.filter((p) => p.indexable);
    const noindex = archive.filter((p) => !p.indexable);
    expect(indexable.length).toBe(12 * 4 * 7);
    expect(noindex.length).toBe(3 * 4 * 7);
  });
});

// ── Locale-completeness of translation chunks ────────────────

describe('services/locales/*-weekly-employers.ts — locale completeness', () => {
  const localeFiles: Record<WeeklyEmployersLocale, string> = {
    it: path.join(ROOT, 'services/locales/it-weekly-employers.ts'),
    en: path.join(ROOT, 'services/locales/en-weekly-employers.ts'),
    de: path.join(ROOT, 'services/locales/de-weekly-employers.ts'),
    fr: path.join(ROOT, 'services/locales/fr-weekly-employers.ts'),
  };

  it('every locale has a translation chunk file', () => {
    for (const [locale, fp] of Object.entries(localeFiles)) {
      expect(fs.existsSync(fp), `missing ${locale}-weekly-employers.ts`).toBe(true);
    }
  });

  function extractKeys(src: string): Set<string> {
    // 'key': … matches both 'key': 'value' and 'key': "value" shapes.
    const re = /'([^']+)':/g;
    const keys = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      keys.add(m[1]);
    }
    return keys;
  }

  it('every translation key present in IT must exist in EN/DE/FR', () => {
    const itKeys = extractKeys(fs.readFileSync(localeFiles.it, 'utf-8'));
    for (const locale of ['en', 'de', 'fr'] as const) {
      const keys = extractKeys(fs.readFileSync(localeFiles[locale], 'utf-8'));
      for (const k of itKeys) {
        expect(keys.has(k), `missing key "${k}" in ${locale}-weekly-employers.ts`).toBe(true);
      }
    }
  });
});

// ── URL structure sanity check ──────────────────────────────

describe('URL structure matches spec', () => {
  it('IT regional current-week URL matches the spec example', () => {
    expect(buildCurrentWeekPath('it', 'ticino')).toBe(
      '/aziende-che-assumono/ticino/settimana-corrente/',
    );
  });

  it('IT regional archive URL matches the spec example', () => {
    expect(buildArchiveWeekPath('it', 'ticino', 16, 2026)).toBe(
      '/aziende-che-assumono/ticino/settimana-16-2026/',
    );
  });

  it('IT per-city current-week URL matches the spec example', () => {
    expect(buildCurrentWeekPath('it', 'lugano')).toBe(
      '/aziende-che-assumono/lugano/settimana-corrente/',
    );
  });

  it('EN/DE/FR examples match the spec', () => {
    expect(buildCurrentWeekPath('en', 'lugano')).toBe('/en/companies-hiring/lugano/current-week/');
    expect(buildArchiveWeekPath('en', 'lugano', 16, 2026)).toBe(
      '/en/companies-hiring/lugano/week-16-2026/',
    );
    expect(buildCurrentWeekPath('de', 'lugano')).toBe('/de/unternehmen-einstellen/lugano/aktuelle-woche/');
    expect(buildArchiveWeekPath('de', 'lugano', 16, 2026)).toBe(
      '/de/unternehmen-einstellen/lugano/woche-16-2026/',
    );
    expect(buildCurrentWeekPath('fr', 'lugano')).toBe('/fr/entreprises-recrutent/lugano/semaine-courante/');
    expect(buildArchiveWeekPath('fr', 'lugano', 16, 2026)).toBe(
      '/fr/entreprises-recrutent/lugano/semaine-16-2026/',
    );
  });
});
