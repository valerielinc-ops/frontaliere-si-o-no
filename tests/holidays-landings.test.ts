/**
 * #4480 — frontaliere public-holiday landings.
 * Path builders/parsers, dataset invariants, and render smoke tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HOLIDAY_LOCALES,
  HOLIDAY_PAGE_IDS,
  HOLIDAY_LANDING_ROUTES,
  buildHolidaysLandingPath,
  parseHolidaysLandingPath,
  isHolidaysLandingPath,
  type HolidaysDataset,
} from '@/build-plugins/holidaysLandingsData';
import {
  __renderHolidayPageForTest,
  __computeBridgesForTest,
} from '@/build-plugins/holidaysLandingsPlugin';
import { MIN_INDEXABLE_WORDS } from '@/build-plugins/constants';
import { expectIndexableWithLargePreview } from './helpers/robotsAssertions';

const DATASET = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'data', 'seo', 'frontaliere-holidays.json'), 'utf8'),
) as HolidaysDataset;

describe('holidays landings — routing', () => {
  it('produces 8 canonical routes (2 page types × 4 locales), all trailing-slash', () => {
    expect(HOLIDAY_LANDING_ROUTES).toHaveLength(8);
    for (const r of HOLIDAY_LANDING_ROUTES) {
      expect(r.endsWith('/')).toBe(true);
      expect(r.startsWith('/')).toBe(true);
    }
    // no duplicates
    expect(new Set(HOLIDAY_LANDING_ROUTES).size).toBe(8);
  });

  it('round-trips build → parse for every locale/page', () => {
    for (const locale of HOLIDAY_LOCALES) {
      for (const page of HOLIDAY_PAGE_IDS) {
        const path = buildHolidaysLandingPath(locale, page);
        expect(parseHolidaysLandingPath(path)).toEqual({ locale, page });
        expect(isHolidaysLandingPath(path)).toBe(true);
      }
    }
  });

  it('IT canonical slugs are the expected keyword URLs', () => {
    expect(buildHolidaysLandingPath('it', 'ticino')).toBe('/giorni-festivi-ticino/');
    expect(buildHolidaysLandingPath('it', 'ch-vs-it')).toBe('/giorni-festivi-svizzera-italia/');
    expect(buildHolidaysLandingPath('en', 'ticino')).toBe('/en/public-holidays-ticino/');
    expect(buildHolidaysLandingPath('de', 'ticino')).toBe('/de/feiertage-tessin/');
    expect(buildHolidaysLandingPath('fr', 'ticino')).toBe('/fr/jours-feries-tessin/');
  });

  it('rejects unrelated paths', () => {
    expect(parseHolidaysLandingPath('/cerca-lavoro-ticino/')).toBeNull();
    expect(isHolidaysLandingPath('/giorni-festivi-zurigo/')).toBe(false);
  });
});

describe('holidays dataset — invariants', () => {
  it('covers two years and every holiday has all 4 locale names + both-year dates', () => {
    expect(DATASET.meta.years.length).toBe(2);
    for (const h of DATASET.holidays) {
      for (const loc of HOLIDAY_LOCALES) {
        expect(h.name[loc], `${h.id} missing ${loc} name`).toBeTruthy();
      }
      for (const y of DATASET.meta.years) {
        expect(h.dates[String(y)], `${h.id} missing ${y}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('has the correct frontaliere non-coincidence sets', () => {
    const tiOnly = DATASET.holidays.filter((h) => h.coincidence === 'ticino-only').map((h) => h.id).sort();
    const itOnly = DATASET.holidays.filter((h) => h.coincidence === 'italy-only').map((h) => h.id).sort();
    // Ticino closed / Italy works
    expect(tiOnly).toEqual(
      ['ascensione', 'corpus-domini', 'festa-nazionale', 'lunedi-pentecoste', 'pietro-paolo', 'venerdi-santo'].sort(),
    );
    // Italy closed / Ticino works
    expect(itOnly).toEqual(['liberazione', 'repubblica']);
  });

  it('coincidence flag is consistent with ticino/italy booleans', () => {
    for (const h of DATASET.holidays) {
      const expected = h.ticino && h.italy ? 'both' : h.ticino ? 'ticino-only' : 'italy-only';
      expect(h.coincidence, h.id).toBe(expected);
    }
  });

  it('Easter-derived dates are correct for 2026 (spot check)', () => {
    const goodFriday = DATASET.holidays.find((h) => h.id === 'venerdi-santo')!;
    expect(goodFriday.dates['2026']).toBe('2026-04-03');
    const corpus = DATASET.holidays.find((h) => h.id === 'corpus-domini')!;
    expect(corpus.dates['2026']).toBe('2026-06-04');
  });
});

describe('holidays landings — render smoke', () => {
  it('every page renders above the thin-content floor with canonical + h1', () => {
    for (const locale of HOLIDAY_LOCALES) {
      for (const page of HOLIDAY_PAGE_IDS) {
        const r = __renderHolidayPageForTest({ locale, page, dateStamp: '2026-07-19' });
        expect(r.wordCount, `${locale}/${page} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toContain('<h1');
        expect(r.html).toContain(`https://frontaliereticino.ch${r.urlPath}`);
        expectIndexableWithLargePreview(r.html, `${locale}/${page}`);
      }
    }
  });

  it('ch-vs-it page names the non-coinciding days', () => {
    const r = __renderHolidayPageForTest({ locale: 'it', page: 'ch-vs-it', dateStamp: '2026-07-19' });
    expect(r.html).toContain('Venerdì Santo');
    expect(r.html).toContain('Anniversario della Liberazione');
  });
});

describe('holidays — bridge computation', () => {
  it('flags Tuesday/Thursday holidays as bridge opportunities in 2026', () => {
    const bridges = __computeBridgesForTest(DATASET.holidays, 2026, 'it');
    // Epifania 2026-01-06 is a Tuesday → bridge Monday 2026-01-05
    const epiphany = bridges.find((b) => b.bridgeDay === '2026-01-05');
    expect(epiphany).toBeTruthy();
    // Corpus Domini 2026-06-04 is a Thursday → bridge Friday 2026-06-05
    const corpus = bridges.find((b) => b.bridgeDay === '2026-06-05');
    expect(corpus).toBeTruthy();
  });
});
