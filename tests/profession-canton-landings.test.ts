/**
 * Per-canton profession landings — routing, enumeration and render invariants.
 */
import { describe, it, expect } from 'vitest';

import {
  PROFESSION_CANTON_ROUTES,
  listAllProfessionCantonPaths,
  parseProfessionCantonPath,
  isProfessionCantonPath,
  buildProfessionCantonPath,
} from '../build-plugins/professionCantonData';
import { renderProfessionCantonPage } from '../build-plugins/professionCantonLandings';
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
  it('enumerates 23 non-TI cantons × 10 professions × 4 locales = 920 routes', () => {
    expect(PROFESSION_CANTON_ROUTES.length).toBe(920);
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
