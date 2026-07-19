/**
 * Salary-intent profession×canton landings (#4461) — routing, enumeration,
 * eligible-id parity, render invariants, below-floor bridge and self-map.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';

import {
  SALARY_PROFESSION_CANTON_ROUTES,
  SALARY_PROFESSION_ELIGIBLE_IDS,
  listAllSalaryProfessionCantonPaths,
  parseSalaryProfessionCantonPath,
  isSalaryProfessionCantonPath,
  buildSalaryProfessionCantonPath,
} from '../build-plugins/salaryProfessionCantonData';
import { PROFESSION_CANTON_KEYS, buildProfessionCantonPath } from '../build-plugins/professionCantonData';
import { PROFESSION_LOCALES } from '../build-plugins/professionLandingsData';
import {
  renderSalaryProfessionCantonPage,
  emitSalaryProfessionCantonPages,
} from '../build-plugins/salaryProfessionCantonPages';
import { _resetProfessionJobsAggregateCache, type FeaturedJob, type ProfessionJobsSnapshot } from '../build-plugins/professionJobsAggregate';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';
import { parsePath } from '../services/router';
import medians from '../data/profession-salary-medians.json' with { type: 'json' };

const PRESET = {
  id: 'infermiere',
  label: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier·ère' },
  medianSalaryChf: 75250,
};

const FEATURED: FeaturedJob = {
  id: 'job-1',
  title: 'Infermiere/a diplomato/a',
  titleByLocale: { it: 'Infermiere/a diplomato/a', en: 'Registered Nurse' },
  company: 'Klinik Hirslanden',
  companyKey: 'hirslanden',
  companyDomain: 'hirslanden.ch',
  city: 'Zürich',
  addressLocality: 'Zürich',
  canton: 'ZH',
  contract: 'permanent',
  salaryMin: 82000,
  salaryMax: 98000,
  postedDate: '2026-07-10',
  daysAgo: 3,
  slug: 'klinik-hirslanden-infermiere-zurigo-abc123',
  slugByLocale: { it: 'klinik-hirslanden-infermiere-zurigo-abc123' },
  employmentType: 'FULL_TIME',
  url: 'https://hirslanden.ch/apply/1',
};

const SNAP: ProfessionJobsSnapshot = {
  liveCount: 14,
  fresh30Count: 6,
  medianSalaryChf: 90000,
  featured: [FEATURED],
  topEmployers: [{ name: 'Klinik Hirslanden', count: 5 }],
};

describe('salaryProfessionCantonData — enumeration + eligible-id parity', () => {
  it('eligible ids match the real median presets in profession-salary-medians.json', () => {
    const presetIds = (medians as { presets: Array<{ id: string }> }).presets.map((p) => p.id).sort();
    expect([...SALARY_PROFESSION_ELIGIBLE_IDS].sort()).toEqual(presetIds);
    expect(SALARY_PROFESSION_ELIGIBLE_IDS.length).toBe(8);
  });

  it('enumerates 23 non-TI cantons × 8 eligible professions × 4 locales = 736 routes', () => {
    expect(PROFESSION_CANTON_KEYS.length).toBe(23);
    expect(SALARY_PROFESSION_CANTON_ROUTES.length).toBe(736);
    expect(SALARY_PROFESSION_CANTON_ROUTES.length).toBe(
      PROFESSION_CANTON_KEYS.length * SALARY_PROFESSION_ELIGIBLE_IDS.length * PROFESSION_LOCALES.length,
    );
    expect(listAllSalaryProfessionCantonPaths().length).toBe(736);
  });

  it('never enumerates Ticino (inherited exclusion)', () => {
    expect(PROFESSION_CANTON_KEYS).not.toContain('TI');
    expect(SALARY_PROFESSION_CANTON_ROUTES.some((p) => /-ticino\//.test(p) || /-tessin\//.test(p))).toBe(false);
  });

  it('every route has a trailing slash and round-trips through parse', () => {
    for (const p of SALARY_PROFESSION_CANTON_ROUTES) {
      expect(p).toMatch(/\/$/);
      const parsed = parseSalaryProfessionCantonPath(p);
      expect(parsed).toBeTruthy();
      expect(parsed!.path).toBe(p);
      expect(isSalaryProfessionCantonPath(p)).toBe(true);
    }
  });

  it('builds the expected per-locale slug shape (profession-then-canton)', () => {
    expect(buildSalaryProfessionCantonPath('it', 'ZH', 'infermiere')).toBe('/stipendio-infermiere-zurigo/');
    expect(buildSalaryProfessionCantonPath('en', 'ZH', 'infermiere')).toBe('/en/salary-nurse-zurich/');
    expect(buildSalaryProfessionCantonPath('de', 'GE', 'ingegnere')).toBe('/de/gehalt-ingenieur-genf/');
    expect(buildSalaryProfessionCantonPath('fr', 'GE', 'assistente-sociale')).toBe('/fr/salaire-assistant-social-geneve/');
  });

  it('rejects non-matching paths', () => {
    expect(isSalaryProfessionCantonPath('/stipendi-zurigo/')).toBe(false); // canton-wide hub
    expect(isSalaryProfessionCantonPath('/lavoro-zurigo-infermiere/')).toBe(false); // job-intent family
    expect(isSalaryProfessionCantonPath('/stipendio-infermiere-ticino/')).toBe(false); // TI excluded
  });
});

describe('salaryProfessionCanton — router integration', () => {
  it('parsePath returns stats + salary-compare + staticOverlay for the family', () => {
    for (const p of SALARY_PROFESSION_CANTON_ROUTES.slice(0, 40)) {
      const { route } = parsePath(p);
      expect(route.staticOverlay).toBe(true);
      expect(route.activeTab).toBe('stats');
      expect(route.statsSubTab).toBe('salary-compare');
    }
  });
});

describe('salaryProfessionCanton — render', () => {
  it('renders an indexable salary page with net estimate, cross-canton table, hreflang and job structured data', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const { html, words } = renderSalaryProfessionCantonPage({
        locale, cantonKey: 'ZH', id: 'infermiere', preset: PRESET, snapshot: SNAP, distDir: '',
      });
      expect(words).toBeGreaterThanOrEqual(50);
      // Scaled gross median for ZH (75250 × 7502/5708 ≈ 99'000).
      expect(html).toMatch(/9[0-9]['’, ]?[0-9]{3}/);
      expect(html).toMatch(/hreflang=["']?x-default["']?/);
      expect(html).not.toMatch(/\bdark:[a-z-]/);
      // Unique value: complete JobPosting structured data for the active job.
      expect(html).toContain('"@type":"JobPosting"');
      expect(html).toContain('"baseSalary"');
      expect(html).toContain('"postalCode"');
      // Cross-link to the localized job-intent page (jobs live there, plan §4.2).
      expect(html).toContain(buildProfessionCantonPath(locale, 'ZH', 'infermiere'));
    }
  });
});

describe('emitSalaryProfessionCantonPages — below-floor bridge + sitemap hygiene', () => {
  it('bridges every below-floor pair to the canton salary-stats hub (empty corpus)', async () => {
    _resetProfessionJobsAggregateCache();
    const tmp = fs.mkdtempSync(np.join(os.tmpdir(), 'salaryprof-bridge-'));
    try {
      fs.mkdirSync(np.join(tmp, 'data'), { recursive: true });
      fs.writeFileSync(np.join(tmp, 'data', 'jobs.json'), '[]', 'utf-8');
      // Provide the real presets so the "no preset" branch isn't the reason for bridging.
      fs.writeFileSync(np.join(tmp, 'data', 'profession-salary-medians.json'), JSON.stringify(medians), 'utf-8');
      const distDir = np.join(tmp, 'dist');
      fs.mkdirSync(distDir, { recursive: true });

      const res = await emitSalaryProfessionCantonPages({ rootDir: tmp, distDir });

      expect(res.pagesWritten).toBe(0);
      expect(res.emittedPaths.length).toBe(0);
      expect(res.bridgesWritten).toBe(
        PROFESSION_CANTON_KEYS.length * SALARY_PROFESSION_ELIGIBLE_IDS.length * PROFESSION_LOCALES.length,
      );

      const canonicalPath = buildSalaryProfessionCantonPath('de', 'ZH', 'infermiere');
      const bridgeFile = np.join(distDir, canonicalPath.replace(/^\/+/, ''), 'index.html');
      expect(fs.existsSync(bridgeFile)).toBe(true);
      const html = fs.readFileSync(bridgeFile, 'utf-8');
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toContain('<link rel="canonical" href="https://frontaliereticino.ch/de/gehaelter-zurich/">');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });

  it('prunes the family <loc> from the sitemap index when zero pages are emitted, leaving siblings intact', async () => {
    _resetProfessionJobsAggregateCache();
    const tmp = fs.mkdtempSync(np.join(os.tmpdir(), 'salaryprof-zeroemit-'));
    try {
      fs.mkdirSync(np.join(tmp, 'data'), { recursive: true });
      fs.writeFileSync(np.join(tmp, 'data', 'jobs.json'), '[]', 'utf-8');
      const distDir = np.join(tmp, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(np.join(distDir, 'sitemap-salary-profession-cantons.xml'), '<urlset/>', 'utf-8');
      fs.writeFileSync(
        np.join(distDir, 'sitemap.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          '  <sitemap>\n    <loc>https://frontaliereticino.ch/sitemap-salary-profession-cantons.xml</loc>\n    <lastmod>2026-06-01</lastmod>\n  </sitemap>\n' +
          '  <sitemap>\n    <loc>https://frontaliereticino.ch/sitemap-salary-stats.xml</loc>\n    <lastmod>2026-06-01</lastmod>\n  </sitemap>\n' +
          '</sitemapindex>\n',
        'utf-8',
      );

      const res = await emitSalaryProfessionCantonPages({ rootDir: tmp, distDir });
      expect(res.pagesWritten).toBe(0);

      const idx = fs.readFileSync(np.join(distDir, 'sitemap.xml'), 'utf-8');
      expect(idx).not.toContain('sitemap-salary-profession-cantons.xml');
      expect(idx).toContain('sitemap-salary-stats.xml');
      expect(fs.existsSync(np.join(distDir, 'sitemap-salary-profession-cantons.xml'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });
});

describe('searchConsoleCompat — salary-intent self-map', () => {
  it('resolves an enumerated salary-intent path to itself (noindex bridge / live page always at same URL)', () => {
    const p = buildSalaryProfessionCantonPath('it', 'ZH', 'infermiere');
    const res = resolveSearchConsoleCompatTarget(p.replace(/\/$/, ''));
    expect(res).toBeTruthy();
    expect(res!.canonicalPath).toBe(p);
    expect(res!.kind).toBe('legacy');
  });
});
