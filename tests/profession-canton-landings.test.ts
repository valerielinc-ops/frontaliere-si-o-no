/**
 * Per-canton profession landings — routing, enumeration and render invariants.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';

import {
  PROFESSION_CANTON_ROUTES,
  listAllProfessionCantonPaths,
  parseProfessionCantonPath,
  isProfessionCantonPath,
  buildProfessionCantonPath,
} from '../build-plugins/professionCantonData';
import {
  renderProfessionCantonPage,
  emitProfessionCantonPages,
} from '../build-plugins/professionCantonLandings';
import { _resetProfessionJobsAggregateCache } from '../build-plugins/professionJobsAggregate';
import { grossregionFromDisplay } from '../build-plugins/shared/cantonSalaryIndex';
import { parsePath } from '../services/router';

const SNAP = {
  liveCount: 12,
  fresh30Count: 5,
  medianSalaryChf: 84000,
  featured: [],
  topEmployers: [
    { name: 'Ospedale Regionale', count: 6 },
    { name: 'Clinica Privata SA', count: 3 },
  ],
};

describe('professionCantonData — enumeration', () => {
  it('enumerates 23 non-TI cantons × 24 professions × 4 locales = 2208 routes', () => {
    expect(PROFESSION_CANTON_ROUTES.length).toBe(2208);
  });
  it('every route has a trailing slash and round-trips through parse', () => {
    for (const p of PROFESSION_CANTON_ROUTES) {
      expect(p).toMatch(/\/$/);
      const parsed = parseProfessionCantonPath(p);
      expect(parsed).toBeTruthy();
      expect(parsed!.path).toBe(p);
      expect(isProfessionCantonPath(p)).toBe(true);
    }
  });
  it('builds the expected IT/EN slug shape', () => {
    expect(buildProfessionCantonPath('it', 'ZH', 'infermiere')).toBe('/lavoro-zurigo-infermiere/');
    expect(buildProfessionCantonPath('en', 'ZH', 'infermiere')).toBe('/en/jobs-zurich-nurse/');
    expect(buildProfessionCantonPath('de', 'GE', 'ingegnere')).toBe('/de/arbeit-genf-ingenieur/');
  });
  it('rejects non-matching paths', () => {
    expect(parseProfessionCantonPath('/lavoro-ticino-infermiere/')).toBeNull(); // legacy TI family
    expect(isProfessionCantonPath('/lavoro-zurigo/')).toBe(false);
  });
});

describe('professionCanton — router integration', () => {
  it('parsePath returns job-board + staticOverlay for the family', () => {
    for (const p of PROFESSION_CANTON_ROUTES.slice(0, 40)) {
      const { route } = parsePath(p);
      expect(route.staticOverlay).toBe(true);
      expect(route.activeTab).toBe('job-board');
    }
  });
});

describe('half-canton group display names resolve to their region (no national fallback)', () => {
  it('Basilea/Basel/Bâle → nordwest; Appenzello/Appenzell → ostschweiz', () => {
    for (const d of ['Basilea', 'Basel', 'Bâle']) expect(grossregionFromDisplay(d)).toBe('nordwest');
    for (const d of ['Appenzello', 'Appenzell']) expect(grossregionFromDisplay(d)).toBe('ostschweiz');
  });
});

describe('professionCanton — render', () => {
  it('renders an indexable page with real employers, salary and hreflang', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const { html, words } = renderProfessionCantonPage({
        locale, cantonKey: 'ZH', id: 'infermiere', snapshot: SNAP, distDir: '',
      });
      expect(words).toBeGreaterThanOrEqual(50);
      expect(html).toContain('Ospedale Regionale'); // real employer chip
      expect(html).toContain('84'); // median salary
      expect(html).toMatch(/hreflang=["']?x-default["']?/);
      expect(html).not.toMatch(/\bdark:[a-z-]/);
    }
  });
});

describe('emitProfessionCantonPages — zero-emit sitemap index hygiene (#2107 item 2)', () => {
  // Regression for the reviewer adversarial check on PR #2095: a build that
  // emits zero pages (empty corpus, or SKIP_PROFESSION_CANTONS gate) must not
  // leave a dangling <loc> to sitemap-profession-cantons.xml in the sitemap
  // index. cleanSitemapFiles deletes the .xml itself, but a <loc> carried over
  // from a prior build would 404 in GSC. removeSitemapFromIndex prunes it.
  it('prunes the profession-cantons <loc> from the index when no pages are emitted, leaving siblings intact', async () => {
    _resetProfessionJobsAggregateCache();
    const tmp = fs.mkdtempSync(np.join(os.tmpdir(), 'profcanton-zeroemit-'));
    try {
      // Empty corpus → aggregateProfessionJobsByCanton yields no cantons → zero emit.
      fs.mkdirSync(np.join(tmp, 'data'), { recursive: true });
      fs.writeFileSync(np.join(tmp, 'data', 'jobs.json'), '[]', 'utf-8');

      const distDir = np.join(tmp, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      // A prior build inserted the family <loc> into the index AND emitted the
      // .xml; simulate the .xml still present so cleanSitemapFiles has work too.
      fs.writeFileSync(np.join(distDir, 'sitemap-profession-cantons.xml'), '<urlset/>', 'utf-8');
      fs.writeFileSync(
        np.join(distDir, 'sitemap.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          '  <sitemap>\n    <loc>https://frontaliereticino.ch/sitemap-profession-cantons.xml</loc>\n    <lastmod>2026-06-01</lastmod>\n  </sitemap>\n' +
          '  <sitemap>\n    <loc>https://frontaliereticino.ch/sitemap-salary-stats.xml</loc>\n    <lastmod>2026-06-01</lastmod>\n  </sitemap>\n' +
          '</sitemapindex>\n',
        'utf-8',
      );

      const res = await emitProfessionCantonPages({ rootDir: tmp, distDir });
      expect(res.pagesWritten).toBe(0);

      const idx = fs.readFileSync(np.join(distDir, 'sitemap.xml'), 'utf-8');
      // Dangling reference to the just-removed family sitemap must be gone…
      expect(idx).not.toContain('sitemap-profession-cantons.xml');
      // …while unrelated index entries survive untouched.
      expect(idx).toContain('sitemap-salary-stats.xml');
      // The family .xml itself is removed by cleanSitemapFiles.
      expect(fs.existsSync(np.join(distDir, 'sitemap-profession-cantons.xml'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });
});
