/**
 * Tests for FiscoLanding — above-the-fold hero + tool grid component
 */
import { describe, it, expect, vi } from 'vitest';

describe('FiscoLanding', () => {
  describe('FISCO_TOOLS constant', () => {
    it('exports 9 tools matching FiscoSubTab values', async () => {
      const { FISCO_TOOLS } = await import('@/components/fisco/FiscoLanding');
      expect(FISCO_TOOLS).toHaveLength(9);
      const keys = FISCO_TOOLS.map((t: { key: string }) => t.key);
      expect(keys).toContain('tax-return');
      expect(keys).toContain('withholding-rates');
      expect(keys).toContain('calendar');
      expect(keys).toContain('holidays');
      expect(keys).toContain('ristorni');
      expect(keys).toContain('pension');
      expect(keys).toContain('pillar3');
      expect(keys).toContain('tax-credit');
      expect(keys).toContain('new-frontier-tax-sim');
    });

    it('each tool has required fields', async () => {
      const { FISCO_TOOLS } = await import('@/components/fisco/FiscoLanding');
      for (const tool of FISCO_TOOLS) {
        expect(tool.key).toBeTruthy();
        expect(tool.icon).toBeTruthy();
        expect(tool.titleKey).toBeTruthy();
        expect(tool.descKey).toBeTruthy();
      }
    });

    it('marks tax-return and pension as popular', async () => {
      const { FISCO_TOOLS } = await import('@/components/fisco/FiscoLanding');
      const popular = FISCO_TOOLS.filter((t: { badge?: string }) => t.badge === 'popular');
      expect(popular).toHaveLength(2);
      const popularKeys = popular.map((t: { key: string }) => t.key);
      expect(popularKeys).toContain('tax-return');
      expect(popularKeys).toContain('pension');
    });
  });

  describe('CROSS_SECTION_CTAS constant', () => {
    it('exports 3 cross-section CTAs', async () => {
      const { CROSS_SECTION_CTAS } = await import('@/components/fisco/FiscoLanding');
      expect(CROSS_SECTION_CTAS).toHaveLength(3);
      const tabs = CROSS_SECTION_CTAS.map((c: { tab: string }) => c.tab);
      expect(tabs).toContain('calculator');
      expect(tabs).toContain('guida');
      expect(tabs).toContain('confronti');
    });
  });

  describe('i18n keys', () => {
    it('all fisco.landing.* keys exist in Italian translations', async () => {
      const { default: translations } = await import('@/services/locales/it-fisco');
      const requiredKeys = [
        'fisco.landing.title',
        'fisco.landing.subtitle',
        'fisco.landing.trust.updated',
        'fisco.landing.trust.free',
        'fisco.landing.trust.tools',
        'fisco.landing.tool.taxReturn.desc',
        'fisco.landing.tool.withholdingRates.desc',
        'fisco.landing.tool.calendar.desc',
        'fisco.landing.tool.holidays.desc',
        'fisco.landing.tool.ristorni.desc',
        'fisco.landing.tool.pension.desc',
        'fisco.landing.tool.pillar3.desc',
        'fisco.landing.tool.taxCredit.desc',
        'fisco.landing.explore',
        'fisco.landing.alsoExplore',
        'fisco.landing.cta.calculator',
        'fisco.landing.cta.guide',
        'fisco.landing.cta.comparators',
      ];
      for (const key of requiredKeys) {
        expect(translations[key], `Missing IT key: ${key}`).toBeTruthy();
      }
    });

    it('all fisco.landing.* keys exist in all 4 locales', async () => {
      const [it, en, de, fr] = await Promise.all([
        import('@/services/locales/it-fisco').then(m => m.default),
        import('@/services/locales/en-fisco').then(m => m.default),
        import('@/services/locales/de-fisco').then(m => m.default),
        import('@/services/locales/fr-fisco').then(m => m.default),
      ]);
      const landingKeys = Object.keys(it).filter(k => k.startsWith('fisco.landing.'));
      expect(landingKeys.length).toBeGreaterThanOrEqual(18);
      for (const key of landingKeys) {
        expect(en[key], `Missing EN key: ${key}`).toBeTruthy();
        expect(de[key], `Missing DE key: ${key}`).toBeTruthy();
        expect(fr[key], `Missing FR key: ${key}`).toBeTruthy();
      }
    });
  });
});
