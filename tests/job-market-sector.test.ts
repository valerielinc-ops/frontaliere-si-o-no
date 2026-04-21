/**
 * Tests for the F4 Per-Sector Snapshot pages (D-3A).
 *
 * Coverage:
 *   • Slug tables + path builders (sector hub) in all 4 locales
 *   • Round-trip parseSectorSnapshotPath(buildSectorSnapshotPath(...))
 *   • Router predicate extended to recognise sector paths
 *   • Page generation: ≥14 sectors × 4 locali = ≥56 pages
 *   • Each page ≥350 words of body content
 *   • Self-referencing canonical + hreflang alternates for all 4 locales
 *   • JSON-LD: BreadcrumbList + WebPage + Dataset + FAQPage
 *   • No `dark:` color classes in generated HTML
 *   • Locale completeness: every sector translated in all 4 locales
 *   • Matcher sanity: jobs containing sector keyword are counted
 */

import { describe, expect, it } from 'vitest';
import {
  JOB_MARKET_SECTOR_DISPLAY,
  JOB_MARKET_SECTOR_KEYS,
  JOB_MARKET_SECTOR_MATCHERS,
  JOB_MARKET_SECTOR_SEGMENT,
  JOB_MARKET_SECTOR_SLUG,
  JOB_MARKET_SNAPSHOT_LOCALES,
  buildSectorSnapshotPath,
  isJobMarketSnapshotPath,
  parseSectorSnapshotPath,
  type JobMarketSectorKey,
  type JobMarketSnapshotLocale,
} from '../build-plugins/jobMarketSnapshotData';
import { generateSectorSnapshotPages } from '../build-plugins/jobMarketSnapshotPlugin';

// ── Slug tables ───────────────────────────────────────────

describe('sector slug tables', () => {
  it('covers at least 14 sectors', () => {
    expect(JOB_MARKET_SECTOR_KEYS.length).toBeGreaterThanOrEqual(14);
  });

  it('has no duplicate sector keys', () => {
    expect(new Set(JOB_MARKET_SECTOR_KEYS).size).toBe(JOB_MARKET_SECTOR_KEYS.length);
  });

  it('uses locale-specific sector segments', () => {
    expect(JOB_MARKET_SECTOR_SEGMENT.it).toBe('settore');
    expect(JOB_MARKET_SECTOR_SEGMENT.en).toBe('sector');
    expect(JOB_MARKET_SECTOR_SEGMENT.de).toBe('branche');
    expect(JOB_MARKET_SECTOR_SEGMENT.fr).toBe('secteur');
  });

  it('exposes a slug for every sector', () => {
    for (const key of JOB_MARKET_SECTOR_KEYS) {
      expect(JOB_MARKET_SECTOR_SLUG[key]).toBeTruthy();
      expect(JOB_MARKET_SECTOR_SLUG[key]).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('exposes a display name for every sector in every locale', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const key of JOB_MARKET_SECTOR_KEYS) {
        const label = JOB_MARKET_SECTOR_DISPLAY[locale][key];
        expect(label, `missing display for ${locale}/${key}`).toBeTruthy();
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it('exposes a regex matcher for every sector', () => {
    for (const key of JOB_MARKET_SECTOR_KEYS) {
      expect(JOB_MARKET_SECTOR_MATCHERS[key]).toBeInstanceOf(RegExp);
    }
  });
});

// ── Path builders ─────────────────────────────────────────

describe('buildSectorSnapshotPath', () => {
  it('builds IT paths under /mercato-lavoro-ticino/settore/<slug>/', () => {
    expect(buildSectorSnapshotPath('it', 'infermieri')).toBe(
      '/mercato-lavoro-ticino/settore/infermieri/',
    );
    expect(buildSectorSnapshotPath('it', 'educatori')).toBe(
      '/mercato-lavoro-ticino/settore/educatori/',
    );
  });

  it('builds EN paths with sector segment', () => {
    expect(buildSectorSnapshotPath('en', 'infermieri')).toBe(
      '/en/ticino-job-market/sector/infermieri/',
    );
  });

  it('builds DE paths with branche segment', () => {
    expect(buildSectorSnapshotPath('de', 'infermieri')).toBe(
      '/de/tessiner-arbeitsmarkt/branche/infermieri/',
    );
  });

  it('builds FR paths with secteur segment', () => {
    expect(buildSectorSnapshotPath('fr', 'infermieri')).toBe(
      '/fr/marche-travail-tessin/secteur/infermieri/',
    );
  });

  it('always produces trailing-slash canonical paths', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const sector of JOB_MARKET_SECTOR_KEYS) {
        const p = buildSectorSnapshotPath(locale, sector);
        expect(p.endsWith('/')).toBe(true);
        expect(p.startsWith('/')).toBe(true);
      }
    }
  });
});

describe('parseSectorSnapshotPath', () => {
  it('round-trips through buildSectorSnapshotPath', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const sector of JOB_MARKET_SECTOR_KEYS) {
        const path = buildSectorSnapshotPath(locale, sector);
        expect(parseSectorSnapshotPath(path)).toEqual({ locale, sector });
      }
    }
  });

  it('tolerates missing trailing slash', () => {
    expect(parseSectorSnapshotPath('/mercato-lavoro-ticino/settore/infermieri')).toEqual({
      locale: 'it',
      sector: 'infermieri',
    });
  });

  it('returns null for unknown sectors', () => {
    expect(parseSectorSnapshotPath('/mercato-lavoro-ticino/settore/astronauta/')).toBeNull();
  });

  it('returns null for paths outside the job-market section', () => {
    expect(parseSectorSnapshotPath('/cerca-lavoro-ticino/infermieri/')).toBeNull();
    expect(parseSectorSnapshotPath('/')).toBeNull();
  });
});

// ── Router predicate extension ────────────────────────────

describe('isJobMarketSnapshotPath — sector extension', () => {
  it('recognises sector paths in all locales', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const path = buildSectorSnapshotPath(locale, 'infermieri');
      expect(isJobMarketSnapshotPath(path), `should match ${path}`).toBe(true);
    }
  });

  it('still rejects unknown sub-paths', () => {
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/settore/unknown-sector/')).toBe(false);
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/other/')).toBe(false);
  });

  it('does not confuse sector segment with monthly slug', () => {
    // "settore" is 7 letters, does not match [a-z]+-\d{4}
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/settore/')).toBe(false);
  });
});

// ── Page generation ───────────────────────────────────────

describe('generateSectorSnapshotPages', () => {
  const today = new Date('2026-04-20T10:00:00.000Z');
  const jobs = [
    { title: 'Infermiere/a 80%', company: 'EOC', location: 'Bellinzona', baseSalary: { value: { minValue: 72000, maxValue: 92000 } } },
    { title: 'Infermiere diplomato', company: 'EOC', location: 'Lugano', baseSalary: { value: { minValue: 70000, maxValue: 88000 } } },
    { title: 'Cassiere', company: 'Coop', location: 'Lugano', baseSalary: { value: { minValue: 48000, maxValue: 56000 } } },
    { title: 'Assistente amministrativo', company: 'Banca Stato', location: 'Bellinzona', baseSalary: { value: { minValue: 60000, maxValue: 78000 } } },
    { title: 'Sviluppatore software', company: 'Lonza', location: 'Visp', baseSalary: { value: { minValue: 85000, maxValue: 115000 } } },
    { title: 'Educatore socio-pedagogico', company: 'Casa Primavera', location: 'Mendrisio', baseSalary: { value: { minValue: 55000, maxValue: 70000 } } },
    { title: 'Meccanico CNC', company: 'Mikron', location: 'Agno', baseSalary: { value: { minValue: 62000, maxValue: 78000 } } },
  ];

  const out = generateSectorSnapshotPages({ history: null, jobs: jobs as any, today });

  it('emits a page per sector × locale (≥56 pages)', () => {
    const expected = JOB_MARKET_SECTOR_KEYS.length * JOB_MARKET_SNAPSHOT_LOCALES.length;
    expect(Object.keys(out.pages).length).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(14 * 4);
  });

  it('every sector × locale canonical path is present', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const sector of JOB_MARKET_SECTOR_KEYS) {
        const path = buildSectorSnapshotPath(locale, sector);
        expect(out.pages[path], `missing ${path}`).toBeTruthy();
      }
    }
  });

  it('every sector page has ≥350 words of body content', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ');
      const words = body.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
      expect(words.length, `page ${path} has only ${words.length} words`).toBeGreaterThanOrEqual(350);
    }
  });

  it('every sector page has self-referencing canonical', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      expect(html, `canonical missing on ${path}`).toContain(
        `<link rel="canonical" href="https://frontaliereticino.ch${path}">`,
      );
    }
  });

  it('every sector page emits hreflang for all 4 locales + x-default', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      expect(html, `hreflang it missing on ${path}`).toContain('hreflang="it"');
      expect(html).toContain('hreflang="en"');
      expect(html).toContain('hreflang="de"');
      expect(html).toContain('hreflang="fr"');
      expect(html).toContain('hreflang="x-default"');
    }
  });

  it('every sector page embeds BreadcrumbList + WebPage + Dataset + FAQPage JSON-LD', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(ldBlocks.length, `${path} missing JSON-LD`).toBeGreaterThanOrEqual(4);
      const types = ldBlocks.map((m) => JSON.parse(m[1])['@type']);
      expect(types, `types for ${path} = ${JSON.stringify(types)}`).toContain('BreadcrumbList');
      expect(types).toContain('WebPage');
      expect(types).toContain('Dataset');
      expect(types).toContain('FAQPage');
    }
  });

  it('every sector page is index,follow (not noindex)', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      expect(html).toContain('name="robots" content="index,follow"');
      expect(html, `${path} is noindex`).not.toContain('name="robots" content="noindex');
    }
  });

  it('no page contains any dark: tailwind prefix', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      // allow only the prose-invert exception
      const stripped = html.replace(/dark:prose-invert/g, '');
      expect(stripped, `dark: prefix leaked in ${path}`).not.toMatch(/\bdark:/);
    }
  });

  it('infermieri page counts at least 2 matching jobs', () => {
    expect(out.sectorStats.infermieri.activeJobs).toBeGreaterThanOrEqual(2);
  });

  it('infermieri top employers list includes EOC', () => {
    expect(out.sectorStats.infermieri.topEmployers.map((e) => e.name)).toContain('EOC');
  });

  it('informatica matches software developer', () => {
    expect(out.sectorStats.informatica.activeJobs).toBeGreaterThanOrEqual(1);
  });

  it('sector page H1 uses the localised display name', () => {
    const path = buildSectorSnapshotPath('it', 'infermieri');
    expect(out.pages[path]).toMatch(/<h1[^>]*>[^<]*infermieri[^<]*<\/h1>/i);
  });
});

// ── Jobs match sanity ─────────────────────────────────────

describe('sector matchers', () => {
  it('infermieri matches localised nurse titles', () => {
    const m = JOB_MARKET_SECTOR_MATCHERS.infermieri;
    expect(m.test('Infermiere 80% EOC')).toBe(true);
    expect(m.test('Pflegefachfrau HF')).toBe(true);
    expect(m.test('Registered nurse hospital')).toBe(true);
    expect(m.test('Infirmier diplômé')).toBe(true);
    expect(m.test('Cassiere Coop')).toBe(false);
  });

  it('educatori matches educator-like titles', () => {
    const m = JOB_MARKET_SECTOR_MATCHERS.educatori;
    expect(m.test('Educatore socio-pedagogico')).toBe(true);
    expect(m.test('Erzieher/in')).toBe(true);
  });

  it('case-anziani matches elderly-care variants', () => {
    const m = JOB_MARKET_SECTOR_MATCHERS['case-anziani'];
    expect(m.test('Casa anziani Pregassona')).toBe(true);
    expect(m.test('EHPAD offre')).toBe(true);
  });
});

// ── Locale completeness ───────────────────────────────────

describe('locale completeness — it/en/de/fr job-market chunks', () => {
  it('every job-market locale chunk has the sector keys', async () => {
    const [it, en, de, fr] = await Promise.all([
      import('../services/locales/it-job-market'),
      import('../services/locales/en-job-market'),
      import('../services/locales/de-job-market'),
      import('../services/locales/fr-job-market'),
    ]);
    const expected = [
      'jobMarket.sector.kicker',
      'jobMarket.sector.h1',
      'jobMarket.sector.activeJobs',
      'jobMarket.sector.weeklyDelta',
      'jobMarket.sector.monthlyDelta',
      'jobMarket.sector.topEmployers',
      'jobMarket.sector.trend',
      'jobMarket.sector.hubCta',
      'jobMarket.sector.snapshotCta',
      'jobMarket.sector.faqTitle',
      'jobMarket.sector.breadcrumb',
      'jobMarket.sector.historyFallback',
    ];
    for (const key of expected) {
      expect(it.default[key], `IT missing ${key}`).toBeTruthy();
      expect(en.default[key], `EN missing ${key}`).toBeTruthy();
      expect(de.default[key], `DE missing ${key}`).toBeTruthy();
      expect(fr.default[key], `FR missing ${key}`).toBeTruthy();
    }
  });
});
