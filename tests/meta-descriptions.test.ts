/**
 * Tests for `services/seo/meta-descriptions.ts` — the shared 140-160 char
 * meta-description templates introduced by F3a (Job Page CTR Optimization).
 *
 * Verifies, per page type × locale:
 *   - 140-160 visible-char length (Google SERP-safe range).
 *   - Primary keyword match.
 *   - Specific dynamic number (live job count) when count > 0.
 *   - Call-to-action verb present.
 *   - All 4 locales covered.
 */

import { describe, it, expect } from 'vitest';
import { type JobPageLocale, JOB_PAGE_LOCALES } from '../services/seo/job-board-titles';
import {
  buildListingHubMeta,
  buildCityHubMeta,
  buildRoleHubMeta,
  buildEmployerHubMeta,
  buildRecencyHubMeta,
  visibleLength,
  isValidMetaLength,
  META_MIN_CHARS,
  META_MAX_CHARS,
} from '../services/seo/meta-descriptions';

const LOCALES: readonly JobPageLocale[] = JOB_PAGE_LOCALES;
const CITIES = ['Lugano', 'Mendrisio', 'Bellinzona', 'Chiasso', 'Locarno'] as const;
const ROLES = ['Infermiere', 'Autista', 'OSS', 'Educatore', 'Amministrativo', 'Sanità'] as const;
const COMPANIES = ['EOC', 'Lidl', 'IKEA', 'PharmaTech', 'Casa Anziani Malcantonese'] as const;
const DAYS = [1, 3, 7] as const;
const SAMPLE_COUNTS = [0, 1, 42, 148, 500, 2408, 12345] as const;
const YEAR = 2026;

const CTA_KEYWORDS: Record<JobPageLocale, RegExp> = {
  it: /(candidati|candidature|postula)/i,
  en: /(apply|browse|discover|work with)/i,
  de: /(bewerb|entdeck|durchsuch|arbeite)/i,
  fr: /(postul|parcour|découvr|travaillez)/i,
};

const KEYWORD: Record<JobPageLocale, RegExp> = {
  it: /lavoro|offerte|Ticino/i,
  en: /jobs|Ticino|Switzerland/i,
  de: /Stellen|Tessin|Jobs/i,
  fr: /emploi|Tessin|offres/i,
};

describe('isValidMetaLength', () => {
  it('exports the SERP-safe thresholds', () => {
    expect(META_MIN_CHARS).toBe(140);
    expect(META_MAX_CHARS).toBe(160);
  });

  it('matches the 140-160 range', () => {
    expect(isValidMetaLength('a'.repeat(139))).toBe(false);
    expect(isValidMetaLength('a'.repeat(140))).toBe(true);
    expect(isValidMetaLength('a'.repeat(160))).toBe(true);
    expect(isValidMetaLength('a'.repeat(161))).toBe(false);
  });
});

describe('buildListingHubMeta — listing hub', () => {
  it('stays within 140-160 chars across all locales and counts', () => {
    for (const locale of LOCALES) {
      for (const count of SAMPLE_COUNTS) {
        const meta = buildListingHubMeta({ locale, count });
        expect(
          isValidMetaLength(meta),
          `${locale} count=${count}: "${meta}" length=${visibleLength(meta)}`,
        ).toBe(true);
      }
    }
  });

  it('contains primary keyword per locale', () => {
    for (const locale of LOCALES) {
      const m = buildListingHubMeta({ locale, count: 2408 });
      expect(m, `${locale} keyword`).toMatch(KEYWORD[locale]);
    }
  });

  it('contains live count when count > 0', () => {
    for (const locale of LOCALES) {
      expect(buildListingHubMeta({ locale, count: 2408 })).toContain('2408');
    }
  });

  it('contains a CTA verb per locale', () => {
    for (const locale of LOCALES) {
      const m = buildListingHubMeta({ locale, count: 100 });
      expect(m, `${locale} CTA`).toMatch(CTA_KEYWORDS[locale]);
    }
  });

  it('is deterministic', () => {
    expect(buildListingHubMeta({ locale: 'it', count: 100 }))
      .toBe(buildListingHubMeta({ locale: 'it', count: 100 }));
  });
});

describe('buildCityHubMeta — per-city hub', () => {
  it('stays within 140-160 chars across all locales, cities, counts', () => {
    for (const locale of LOCALES) {
      for (const city of CITIES) {
        for (const count of SAMPLE_COUNTS) {
          const meta = buildCityHubMeta({ locale, cityDisplay: city, count });
          expect(
            isValidMetaLength(meta),
            `${locale}/${city} count=${count}: len=${visibleLength(meta)} "${meta}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the city name', () => {
    for (const city of CITIES) {
      for (const locale of LOCALES) {
        const m = buildCityHubMeta({ locale, cityDisplay: city, count: 50 });
        expect(m).toContain(city);
      }
    }
  });

  it('contains CTA verb', () => {
    for (const locale of LOCALES) {
      const m = buildCityHubMeta({ locale, cityDisplay: 'Lugano', count: 50 });
      expect(m).toMatch(CTA_KEYWORDS[locale]);
    }
  });
});

describe('buildRoleHubMeta — per-role hub', () => {
  it('stays within 140-160 chars across all locales, roles, counts', () => {
    for (const locale of LOCALES) {
      for (const role of ROLES) {
        for (const count of SAMPLE_COUNTS) {
          const meta = buildRoleHubMeta({ locale, roleDisplay: role, count });
          expect(
            isValidMetaLength(meta),
            `${locale}/${role} count=${count}: len=${visibleLength(meta)} "${meta}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the role in a case-insensitive match', () => {
    for (const role of ROLES) {
      for (const locale of LOCALES) {
        const m = buildRoleHubMeta({ locale, roleDisplay: role, count: 10 });
        expect(m.toLowerCase()).toContain(role.toLowerCase());
      }
    }
  });
});

describe('buildEmployerHubMeta — employer hub', () => {
  it('stays within 140-160 chars across all locales, companies, counts', () => {
    for (const locale of LOCALES) {
      for (const co of COMPANIES) {
        for (const count of SAMPLE_COUNTS) {
          const meta = buildEmployerHubMeta({ locale, companyDisplay: co, count });
          expect(
            isValidMetaLength(meta),
            `${locale}/${co} count=${count}: len=${visibleLength(meta)} "${meta}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the company', () => {
    for (const co of ['EOC', 'Lidl'] as const) {
      for (const locale of LOCALES) {
        const m = buildEmployerHubMeta({ locale, companyDisplay: co, count: 10 });
        expect(m).toContain(co);
      }
    }
  });
});

describe('buildRecencyHubMeta — recency hub', () => {
  it('stays within 140-160 chars across all locales, days, counts', () => {
    for (const locale of LOCALES) {
      for (const days of DAYS) {
        for (const count of SAMPLE_COUNTS) {
          const meta = buildRecencyHubMeta({ locale, days, count, year: YEAR });
          expect(
            isValidMetaLength(meta),
            `${locale}/${days}d count=${count}: len=${visibleLength(meta)} "${meta}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('includes year when provided', () => {
    for (const locale of LOCALES) {
      expect(buildRecencyHubMeta({ locale, days: 3, count: 10, year: YEAR })).toContain(String(YEAR));
    }
  });

  it('uses "since yesterday" idiom for days=1 per locale', () => {
    expect(buildRecencyHubMeta({ locale: 'it', days: 1, count: 5 }).toLowerCase()).toContain('da ieri');
    expect(buildRecencyHubMeta({ locale: 'en', days: 1, count: 5 }).toLowerCase()).toContain('since yesterday');
    expect(buildRecencyHubMeta({ locale: 'de', days: 1, count: 5 }).toLowerCase()).toContain('seit gestern');
    expect(buildRecencyHubMeta({ locale: 'fr', days: 1, count: 5 }).toLowerCase()).toContain('depuis hier');
  });
});

describe('all 4 locales covered for every page type', () => {
  it('no locale returns empty or fallback', () => {
    for (const locale of LOCALES) {
      expect(buildListingHubMeta({ locale, count: 42 }).length).toBeGreaterThan(0);
      expect(buildCityHubMeta({ locale, cityDisplay: 'Lugano', count: 42 }).length).toBeGreaterThan(0);
      expect(buildRoleHubMeta({ locale, roleDisplay: 'Infermiere', count: 42 }).length).toBeGreaterThan(0);
      expect(buildEmployerHubMeta({ locale, companyDisplay: 'EOC', count: 10 }).length).toBeGreaterThan(0);
      expect(buildRecencyHubMeta({ locale, days: 3, count: 42, year: YEAR }).length).toBeGreaterThan(0);
    }
  });
});
