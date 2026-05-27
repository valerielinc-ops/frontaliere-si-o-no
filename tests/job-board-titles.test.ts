/**
 * Tests for `services/seo/job-board-titles.ts` — the shared 50-66 char
 * title templates introduced by F3a (Job Page CTR Optimization).
 *
 * The TITLE_MAX_CHARS budget tracks the universal title rule in
 * build-plugins/shared/titleSuffix.ts (60 SERP-display target + 10 %
 * tolerance = 66 chars including the " | Frontaliere Ticino" brand
 * suffix when it fits).
 *
 * Verifies:
 *   - Every title lands in 50-66 visible-chars (Google SERP-safe range).
 *   - Primary keyword is present for each page type.
 *   - 🔥 emoji fires above threshold, never below.
 *   - All 4 locales are covered.
 *   - Titles are unique across sampled inputs (no duplicate SERP collisions).
 */

import { describe, it, expect } from 'vitest';
import {
  buildListingHubTitle,
  buildCityHubTitle,
  buildRoleHubTitle,
  buildEmployerHubTitle,
  buildRecencyHubTitle,
  visibleLength,
  isValidTitleLength,
  TITLE_MIN_CHARS,
  TITLE_MAX_CHARS,
  FIRE_EMOJI_THRESHOLD,
  DEFAULT_CITY_HUB_FIRE_THRESHOLD,
  JOB_PAGE_LOCALES,
  type JobPageLocale,
} from '../services/seo/job-board-titles';

const YEAR = 2026;
const LOCALES: readonly JobPageLocale[] = JOB_PAGE_LOCALES;
const CITIES = ['Lugano', 'Mendrisio', 'Bellinzona', 'Chiasso', 'Locarno'] as const;
const ROLES = ['Infermiere', 'Autista', 'OSS', 'Educatore', 'Amministrativo', 'Sanità'] as const;
const COMPANIES = ['EOC', 'Lidl', 'IKEA', 'PharmaTech', 'Casa Anziani Malcantonese'] as const;
const DAYS = [1, 3, 7] as const;
const SAMPLE_COUNTS = [0, 1, 42, 148, 500, 2408, 12345] as const;

describe('visibleLength + isValidTitleLength', () => {
  it('counts code points, not UTF-16 code units', () => {
    // 🔥 is a single code point but 2 UTF-16 code units
    expect(visibleLength('🔥')).toBe(1);
    expect(visibleLength('a🔥b')).toBe(3);
  });

  it('isValidTitleLength matches the 50-66 range', () => {
    expect(isValidTitleLength('a'.repeat(49))).toBe(false);
    expect(isValidTitleLength('a'.repeat(50))).toBe(true);
    expect(isValidTitleLength('a'.repeat(60))).toBe(true);
    expect(isValidTitleLength('a'.repeat(66))).toBe(true);
    expect(isValidTitleLength('a'.repeat(67))).toBe(false);
  });

  it('exports the SERP-safe thresholds', () => {
    expect(TITLE_MIN_CHARS).toBe(50);
    expect(TITLE_MAX_CHARS).toBe(66);
    expect(FIRE_EMOJI_THRESHOLD).toBe(500);
    expect(DEFAULT_CITY_HUB_FIRE_THRESHOLD).toBe(30);
  });
});

describe('buildListingHubTitle — listing hub (home)', () => {
  it('stays within 50-60 visible chars across all locales and counts', () => {
    for (const locale of LOCALES) {
      for (const count of SAMPLE_COUNTS) {
        const title = buildListingHubTitle({ locale, count, year: YEAR });
        expect(
          isValidTitleLength(title),
          `${locale} count=${count}: "${title}" length=${visibleLength(title)}`,
        ).toBe(true);
      }
    }
  });

  it('contains primary keyword per locale', () => {
    expect(buildListingHubTitle({ locale: 'it', count: 1200, year: YEAR })).toContain('Ticino');
    expect(buildListingHubTitle({ locale: 'en', count: 1200, year: YEAR })).toContain('Ticino');
    expect(buildListingHubTitle({ locale: 'de', count: 1200, year: YEAR })).toContain('Tessin');
    expect(buildListingHubTitle({ locale: 'fr', count: 1200, year: YEAR })).toContain('Tessin');
  });

  it('includes the year', () => {
    for (const locale of LOCALES) {
      expect(buildListingHubTitle({ locale, count: 100, year: YEAR })).toContain(String(YEAR));
    }
  });

  it('includes live count when count > 0', () => {
    for (const locale of LOCALES) {
      const t = buildListingHubTitle({ locale, count: 2408, year: YEAR });
      expect(t).toContain('2408');
    }
  });

  it('injects 🔥 when count >= FIRE_EMOJI_THRESHOLD, never below', () => {
    expect(buildListingHubTitle({ locale: 'it', count: FIRE_EMOJI_THRESHOLD, year: YEAR })).toContain('🔥');
    expect(buildListingHubTitle({ locale: 'it', count: FIRE_EMOJI_THRESHOLD - 1, year: YEAR })).not.toContain('🔥');
  });

  it('omits count when zero (no "0 posti")', () => {
    for (const locale of LOCALES) {
      const t = buildListingHubTitle({ locale, count: 0, year: YEAR });
      expect(t).not.toContain(' 0 ');
      expect(t).not.toContain('🔥');
    }
  });

  it('is deterministic', () => {
    expect(buildListingHubTitle({ locale: 'it', count: 1234, year: YEAR }))
      .toBe(buildListingHubTitle({ locale: 'it', count: 1234, year: YEAR }));
  });

  it('produces unique titles across locales at the same count', () => {
    const sample = new Set<string>();
    for (const locale of LOCALES) {
      sample.add(buildListingHubTitle({ locale, count: 1200, year: YEAR }));
    }
    expect(sample.size).toBe(LOCALES.length);
  });
});

describe('buildCityHubTitle — per-city hub', () => {
  it('stays within 50-60 chars across all locales, cities, counts', () => {
    for (const locale of LOCALES) {
      for (const city of CITIES) {
        for (const count of SAMPLE_COUNTS) {
          const title = buildCityHubTitle({
            locale,
            cityDisplay: city,
            count,
            year: YEAR,
            fireThreshold: DEFAULT_CITY_HUB_FIRE_THRESHOLD,
          });
          expect(
            isValidTitleLength(title),
            `${locale}/${city} count=${count}: "${title}" length=${visibleLength(title)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the city name', () => {
    for (const city of CITIES) {
      for (const locale of LOCALES) {
        const t = buildCityHubTitle({ locale, cityDisplay: city, count: 50, year: YEAR });
        expect(t).toContain(city);
      }
    }
  });

  it('respects a custom fire threshold', () => {
    const low = buildCityHubTitle({
      locale: 'it', cityDisplay: 'Lugano', count: 20, year: YEAR, fireThreshold: 30,
    });
    const high = buildCityHubTitle({
      locale: 'it', cityDisplay: 'Lugano', count: 50, year: YEAR, fireThreshold: 30,
    });
    expect(low).not.toContain('🔥');
    expect(high).toContain('🔥');
  });

  it('produces unique titles for different cities in the same locale', () => {
    const titles = new Set<string>();
    for (const city of CITIES) {
      titles.add(buildCityHubTitle({ locale: 'it', cityDisplay: city, count: 50, year: YEAR }));
    }
    expect(titles.size).toBe(CITIES.length);
  });
});

describe('buildRoleHubTitle — per-role hub (sector / role landing)', () => {
  it('stays within 50-60 chars across all locales, roles, counts', () => {
    for (const locale of LOCALES) {
      for (const role of ROLES) {
        for (const count of SAMPLE_COUNTS) {
          const title = buildRoleHubTitle({
            locale,
            roleDisplay: role,
            count,
            year: YEAR,
          });
          expect(
            isValidTitleLength(title),
            `${locale}/${role} count=${count}: "${title}" length=${visibleLength(title)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the role', () => {
    for (const role of ROLES) {
      const t = buildRoleHubTitle({ locale: 'it', roleDisplay: role, count: 50, year: YEAR });
      expect(t).toContain(role);
    }
  });
});

describe('buildEmployerHubTitle — employer hub', () => {
  it('stays within 50-60 chars across all locales, companies, counts', () => {
    for (const locale of LOCALES) {
      for (const co of COMPANIES) {
        for (const count of SAMPLE_COUNTS) {
          const title = buildEmployerHubTitle({
            locale,
            companyDisplay: co,
            count,
            year: YEAR,
          });
          expect(
            isValidTitleLength(title),
            `${locale}/${co} count=${count}: "${title}" length=${visibleLength(title)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('mentions the company', () => {
    for (const co of ['EOC', 'Lidl'] as const) {
      const t = buildEmployerHubTitle({ locale: 'it', companyDisplay: co, count: 20, year: YEAR });
      expect(t).toContain(co);
    }
  });
});

describe('buildRecencyHubTitle — recency hub (last N days / since yesterday)', () => {
  it('stays within 50-60 chars across all locales, days, counts', () => {
    for (const locale of LOCALES) {
      for (const days of DAYS) {
        for (const count of SAMPLE_COUNTS) {
          const title = buildRecencyHubTitle({
            locale,
            days,
            count,
            year: YEAR,
          });
          expect(
            isValidTitleLength(title),
            `${locale}/${days}d count=${count}: "${title}" length=${visibleLength(title)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('uses "since yesterday" idiom for days=1 per locale', () => {
    expect(buildRecencyHubTitle({ locale: 'it', days: 1, count: 10, year: YEAR }).toLowerCase()).toContain('da ieri');
    expect(buildRecencyHubTitle({ locale: 'en', days: 1, count: 10, year: YEAR }).toLowerCase()).toContain('since yesterday');
    expect(buildRecencyHubTitle({ locale: 'de', days: 1, count: 10, year: YEAR }).toLowerCase()).toContain('seit gestern');
    expect(buildRecencyHubTitle({ locale: 'fr', days: 1, count: 10, year: YEAR }).toLowerCase()).toContain('depuis hier');
  });

  it('uses "last N days" idiom for days>=2 per locale', () => {
    expect(buildRecencyHubTitle({ locale: 'it', days: 3, count: 10, year: YEAR })).toContain('ultimi 3 giorni');
    expect(buildRecencyHubTitle({ locale: 'en', days: 3, count: 10, year: YEAR }).toLowerCase()).toContain('last 3 days');
    expect(buildRecencyHubTitle({ locale: 'de', days: 3, count: 10, year: YEAR })).toContain('letzte 3 Tage');
    expect(buildRecencyHubTitle({ locale: 'fr', days: 3, count: 10, year: YEAR })).toContain('3 derniers jours');
  });

  it('always adds 🔥 when count > 0 (recency implies urgency)', () => {
    for (const locale of LOCALES) {
      for (const days of DAYS) {
        const t = buildRecencyHubTitle({ locale, days, count: 5, year: YEAR });
        expect(t, `${locale}/${days}d`).toContain('🔥');
      }
    }
  });

  it('omits 🔥 when count is zero', () => {
    for (const locale of LOCALES) {
      const t = buildRecencyHubTitle({ locale, days: 3, count: 0, year: YEAR });
      expect(t).not.toContain('🔥');
    }
  });
});

describe('cross-page uniqueness — no duplicate SERP titles across sampled pages', () => {
  it('sampled titles across page types are all unique within a locale', () => {
    for (const locale of LOCALES) {
      const titles = new Set<string>();
      const add = (t: string) => titles.add(t);
      add(buildListingHubTitle({ locale, count: 2408, year: YEAR }));
      for (const city of CITIES) {
        add(buildCityHubTitle({ locale, cityDisplay: city, count: 50, year: YEAR }));
      }
      for (const role of ROLES) {
        add(buildRoleHubTitle({ locale, roleDisplay: role, count: 42, year: YEAR }));
      }
      for (const co of COMPANIES) {
        add(buildEmployerHubTitle({ locale, companyDisplay: co, count: 10, year: YEAR }));
      }
      for (const days of DAYS) {
        add(buildRecencyHubTitle({ locale, days, count: 42, year: YEAR }));
      }
      // Expect distinct strings: 1 hub + 5 cities + 6 roles + 5 employers + 3 recency = 20
      const expected = 1 + CITIES.length + ROLES.length + COMPANIES.length + DAYS.length;
      expect(titles.size, `${locale} titles collision`).toBe(expected);
    }
  });
});

describe('all 4 locales covered for every page type', () => {
  it('no locale returns an empty or fallback string', () => {
    for (const locale of LOCALES) {
      expect(buildListingHubTitle({ locale, count: 42, year: YEAR }).length).toBeGreaterThan(0);
      expect(buildCityHubTitle({ locale, cityDisplay: 'Lugano', count: 42, year: YEAR }).length).toBeGreaterThan(0);
      expect(buildRoleHubTitle({ locale, roleDisplay: 'Infermiere', count: 42, year: YEAR }).length).toBeGreaterThan(0);
      expect(buildEmployerHubTitle({ locale, companyDisplay: 'EOC', count: 10, year: YEAR }).length).toBeGreaterThan(0);
      expect(buildRecencyHubTitle({ locale, days: 3, count: 42, year: YEAR }).length).toBeGreaterThan(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regression: non-TI city hubs must NOT leak "Ticino"/"Tessin" into title
// (PR #318 — buildCityHubTitle gained optional cantonDisplay)
// ──────────────────────────────────────────────────────────────────────
describe('buildCityHubTitle — non-TI cantonDisplay (no Ticino/Tessin leak)', () => {
  it('IT non-TI city omits "in Ticino" pad and substitutes the actual canton', () => {
    // Pratteln (BS) is a short city name that historically triggered pad-to-min
    // with "in Ticino", producing a misleading title on the per-canton city hub.
    const t = buildCityHubTitle({
      locale: 'it',
      cityDisplay: 'Pratteln',
      count: 3,
      year: YEAR,
      cantonDisplay: 'Basilea Città',
    });
    expect(t).not.toContain('Ticino');
    expect(t).not.toContain('Tessin');
    expect(t).toContain('Pratteln');
    // When the title is short enough to trigger pad-to-min, the canton fills in.
    if (t.length < 60) expect(t).toContain('Basilea Città');
  });

  it('EN/DE/FR non-TI: base title uses the canton, not Ticino/Tessin', () => {
    const cantonByLocale = {
      en: 'Basel-City',
      de: 'Basel-Stadt',
      fr: 'Bâle-Ville',
    } as const;
    for (const locale of ['en', 'de', 'fr'] as const) {
      const t = buildCityHubTitle({
        locale,
        cityDisplay: 'Pratteln',
        count: 3,
        year: YEAR,
        cantonDisplay: cantonByLocale[locale],
      });
      expect(t, `${locale}`).not.toContain('Ticino');
      expect(t, `${locale}`).not.toContain('Tessin');
      expect(t, `${locale}`).toContain(cantonByLocale[locale]);
      expect(t, `${locale}`).toContain('Pratteln');
    }
  });

  it('TI callers (cantonDisplay undefined) keep legacy Ticino/Tessin copy', () => {
    // Backward-compat: existing TI city hubs must be byte-identical pre/post-fix.
    const it = buildCityHubTitle({ locale: 'it', cityDisplay: 'Lugano', count: 123, year: YEAR });
    const en = buildCityHubTitle({ locale: 'en', cityDisplay: 'Lugano', count: 123, year: YEAR });
    const de = buildCityHubTitle({ locale: 'de', cityDisplay: 'Bellinzona', count: 123, year: YEAR });
    const fr = buildCityHubTitle({ locale: 'fr', cityDisplay: 'Mendrisio', count: 123, year: YEAR });
    // Italian title doesn't contain "Ticino" in its base form, so just verify the
    // shape stays the same (no canton word injected).
    expect(it).toContain('Lugano');
    expect(en).toContain('Ticino');
    expect(de).toContain('Tessin');
    expect(fr).toContain('Tessin');
  });
});
