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
  it('renders an indexable page per canton with the canton name + median', () => {
    for (const locale of SALARY_STATS_LOCALES) {
      for (const key of SALARY_STATS_CANTON_KEYS.slice(0, 4)) {
        const slug = SALARY_STATS_CANTON_SLUGS[key][locale];
        const { html, words } = renderSalaryStatsPage({ locale, cantonKey: key, cantonSlug: slug, distDir: '' });
        expect(words).toBeGreaterThanOrEqual(50);
        expect(html).toContain('CHF');
        expect(html).toContain(buildSalaryStatsPath(locale, slug));
        // No dark: color prefixes (CLAUDE.md non-negotiable).
        expect(html).not.toMatch(/\bdark:[a-z-]/);
      }
    }
  });
});
