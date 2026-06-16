/**
 * Per-canton salary-statistics landing family — routing, slug parity and
 * render invariants.
 */
import { describe, it, expect } from 'vitest';

import cantonSlugsRaw from '../data/canton-url-slugs.json';
import {
  SALARY_STATS_ROUTES,
  SALARY_STATS_CANTON_KEYS,
  SALARY_STATS_CANTON_SLUGS,
  SALARY_STATS_LOCALES,
  parseSalaryStatsPath,
  isSalaryStatsPath,
  buildSalaryStatsPath,
} from '../build-plugins/salaryStatsData';
import { renderSalaryStatsPage } from '../build-plugins/salaryStatsChCantonPages';
import { parsePath } from '../services/router';

describe('salaryStatsData — path enumeration', () => {
  it('emits one path per locale × canton (24 cantons × 4 = 96)', () => {
    expect(SALARY_STATS_CANTON_KEYS.length).toBe(24);
    expect(SALARY_STATS_ROUTES.length).toBe(96);
  });

  it('every path is normalized with a trailing slash', () => {
    for (const p of SALARY_STATS_ROUTES) expect(p).toMatch(/\/$/);
  });

  it('parseSalaryStatsPath round-trips every canonical path', () => {
    for (const p of SALARY_STATS_ROUTES) {
      const parsed = parseSalaryStatsPath(p);
      expect(parsed).toBeTruthy();
      expect(parsed!.path).toBe(p);
      expect(isSalaryStatsPath(p)).toBe(true);
    }
  });

  it('non-matching paths return null', () => {
    expect(parseSalaryStatsPath('/stipendi/')).toBeNull();
    expect(parseSalaryStatsPath('/en/salaries/')).toBeNull();
    expect(isSalaryStatsPath('/cerca-lavoro-zurigo/')).toBe(false);
  });
});

describe('salaryStatsData — slug parity with canton-url-slugs.json', () => {
  const jsonCantons = (cantonSlugsRaw as { cantons: Record<string, Record<string, string>> }).cantons;

  it('covers exactly the same canton keys as the JSON', () => {
    expect([...SALARY_STATS_CANTON_KEYS].sort()).toEqual(Object.keys(jsonCantons).sort());
  });

  it('base slugs match the JSON for all locales', () => {
    for (const key of SALARY_STATS_CANTON_KEYS) {
      for (const locale of SALARY_STATS_LOCALES) {
        expect(SALARY_STATS_CANTON_SLUGS[key][locale]).toBe(jsonCantons[key][locale]);
      }
    }
  });
});

describe('salaryStats — router integration', () => {
  it('parsePath returns stats/salary-compare with staticOverlay for every path', () => {
    for (const p of SALARY_STATS_ROUTES) {
      const { route } = parsePath(p);
      expect(route.staticOverlay).toBe(true);
      expect(route.activeTab).toBe('stats');
      expect(route.statsSubTab).toBe('salary-compare');
    }
  });
});

describe('salaryStats — page render', () => {
  it('every (canton × locale) page clears the indexable-words gate (no router-route-without-page 404)', () => {
    let rendered = 0;
    for (const locale of SALARY_STATS_LOCALES) {
      for (const key of SALARY_STATS_CANTON_KEYS) {
        const slug = SALARY_STATS_CANTON_SLUGS[key][locale];
        const { html, words } = renderSalaryStatsPage({ locale, cantonKey: key, cantonSlug: slug, distDir: '' });
        expect(words).toBeGreaterThanOrEqual(50);
        expect(html).toContain('CHF');
        expect(html).toContain(buildSalaryStatsPath(locale, slug));
        // hreflang cluster present (all 4 locale variants cross-linked).
        // The HTML minifier strips attribute quotes, so match unquoted.
        expect(html).toMatch(/hreflang=["']?en["']?/);
        expect(html).toMatch(/hreflang=["']?x-default["']?/);
        // No dark: color prefixes (CLAUDE.md non-negotiable).
        expect(html).not.toMatch(/\bdark:[a-z-]/);
        rendered++;
      }
    }
    expect(rendered).toBe(96);
  });

  it('Dataset JSON-LD uses Google-valid field types (regression: GSC spatialCoverage/creator/license)', () => {
    const { html } = renderSalaryStatsPage({ locale: 'it', cantonKey: 'ZH', cantonSlug: SALARY_STATS_CANTON_SLUGS['ZH']['it'], distDir: '' });
    const datasets = [...html.matchAll(/<script type=["']?application\/ld\+json["']?>([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .filter((o) => o['@type'] === 'Dataset');
    expect(datasets.length).toBe(1);
    const ds = datasets[0];
    // creator must be Organization|Person (not GovernmentOrganization — Google
    // Dataset validator does not traverse subtypes → "invalid object type").
    expect(['Organization', 'Person']).toContain(ds.creator['@type']);
    // spatialCoverage must be Place (not AdministrativeArea subtype).
    expect(ds.spatialCoverage['@type']).toBe('Place');
    // license is a required field for Dataset rich results.
    expect(typeof ds.license).toBe('string');
    expect(ds.license).toMatch(/^https?:\/\//);
  });

  it('half-canton groups get region figures, not silent national fallback', () => {
    // APPENZELLO → Ostschweiz median 6623 (≈94% of national 7024) — diverges
    // enough that the gross band must scale BELOW the national anchor. Before
    // the fix the display name "Appenzello" missed the display→region table and
    // the band silently fell back to the national 110'000 high.
    const { html } = renderSalaryStatsPage({ locale: 'it', cantonKey: 'APPENZELLO', cantonSlug: 'appenzello', distDir: '' });
    expect(html).toContain('94%'); // vs-national tile (region median path)
    expect(html).toContain("105'000"); // gross-band high = round5000(110000 × 6623/7024), region-scaled
  });
});
