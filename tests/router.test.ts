import { describe, it, expect } from 'vitest';
import { buildPath, parsePath } from '@/services/router';

const ALL_COMPARATORI_SUBTABS = [
  'exchange', 'mobile', 'transport', 'health', 'banks',
  'traffic', 'jobs', 'shopping', 'cost-of-living',
  'ral', 'parental-leave', 'border-map', 'residency',
] as const;

const ALL_GUIDE_SECTIONS = [
  'municipalities', 'living-ch', 'living-it', 'border',
  'calendar', 'holidays', 'permits', 'companies',
  'places', 'schools', 'unemployment', 'first-day',
] as const;

const ALL_LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('Router — buildPath', () => {
  describe('Comparatori subtabs produce valid paths (no undefined segments)', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of ALL_COMPARATORI_SUBTABS) {
        it(`[${locale}] comparatori/${sub} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'comparatori', comparatoriSubTab: sub },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
          expect(path).toMatch(/^\/[a-z0-9/-]+$/);
        });
      }
    }
  });

  describe('Guide sections produce valid paths', () => {
    for (const locale of ALL_LOCALES) {
      for (const section of ALL_GUIDE_SECTIONS) {
        it(`[${locale}] guide/${section} → valid path`, () => {
          const path = buildPath(
            { activeTab: 'guide', guideSection: section },
            locale,
          );
          expect(path).toBeDefined();
          expect(path).not.toContain('undefined');
        });
      }
    }
  });
});

describe('Router — parsePath roundtrip', () => {
  describe('Comparatori paths survive roundtrip', () => {
    for (const locale of ALL_LOCALES) {
      for (const sub of ALL_COMPARATORI_SUBTABS) {
        it(`[${locale}] comparatori/${sub} roundtrips`, () => {
          const path = buildPath(
            { activeTab: 'comparatori', comparatoriSubTab: sub },
            locale,
          );
          const { route } = parsePath(path);
          expect(route.activeTab).toBe('comparatori');
          expect(route.comparatoriSubTab).toBe(sub);
        });
      }
    }
  });
});

describe('Router — backward compatibility', () => {
  it('old /comparatori/costi-pendolarismo redirects to cost-of-living', () => {
    const { route } = parsePath('/comparatori/costi-pendolarismo');
    expect(route.activeTab).toBe('comparatori');
    expect(route.comparatoriSubTab).toBe('cost-of-living');
  });

  it('old /en/comparators/commuting-costs redirects to cost-of-living', () => {
    const { route } = parsePath('/en/comparators/commuting-costs');
    expect(route.activeTab).toBe('comparatori');
    expect(route.comparatoriSubTab).toBe('cost-of-living');
  });
});

describe('Router — gamification tab', () => {
  for (const locale of ALL_LOCALES) {
    it(`[${locale}] gamification → valid path`, () => {
      const path = buildPath({ activeTab: 'gamification' }, locale);
      expect(path).toBeDefined();
      expect(path).not.toContain('undefined');
      expect(path).toMatch(/^\/[a-z0-9/-]+$/);
    });

    it(`[${locale}] gamification roundtrips`, () => {
      const path = buildPath({ activeTab: 'gamification' }, locale);
      const { route } = parsePath(path);
      expect(route.activeTab).toBe('gamification');
    });
  }

  it('[it] uses /gamificazione slug', () => {
    const path = buildPath({ activeTab: 'gamification' }, 'it');
    expect(path).toContain('gamificazione');
  });

  it('[en] uses /gamification slug', () => {
    const path = buildPath({ activeTab: 'gamification' }, 'en');
    expect(path).toContain('gamification');
  });
});

describe('Router — dashboard tab', () => {
  for (const locale of ALL_LOCALES) {
    it(`[${locale}] dashboard → valid path`, () => {
      const path = buildPath({ activeTab: 'dashboard' }, locale);
      expect(path).toBeDefined();
      expect(path).not.toContain('undefined');
      expect(path).toMatch(/^\/[a-z0-9/-]+$/);
    });

    it(`[${locale}] dashboard roundtrips`, () => {
      const path = buildPath({ activeTab: 'dashboard' }, locale);
      const { route } = parsePath(path);
      expect(route.activeTab).toBe('dashboard');
    });
  }

  it('[it] uses /dashboard slug', () => {
    const path = buildPath({ activeTab: 'dashboard' }, 'it');
    expect(path).toContain('dashboard');
  });

  it('[fr] uses /tableau-de-bord slug', () => {
    const path = buildPath({ activeTab: 'dashboard' }, 'fr');
    expect(path).toContain('tableau-de-bord');
  });
});
