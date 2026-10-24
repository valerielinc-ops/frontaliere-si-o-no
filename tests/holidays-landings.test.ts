/**
 * #4480 — frontaliere public-holiday landings.
 * Path builders/parsers, dataset invariants, and render smoke tests.
 */
import { describe, it, expect } from 'vitest';
import { expectGenerationDateLabel } from './helpers/generationDateAssertions';
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
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import {
  buildHolidaysDataset,
  holidayFocusYear,
  holidayYearsFor,
} from '../build-plugins/shared/ticinoHolidaysCatalog.mjs';

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
      ['ascensione', 'corpus-domini', 'festa-nazionale', 'lunedi-pentecoste', 'pietro-paolo', 'san-giuseppe'].sort(),
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
    const easterMonday = DATASET.holidays.find((h) => h.id === 'lunedi-angelo')!;
    expect(easterMonday.dates['2026']).toBe('2026-04-06');
    const corpus = DATASET.holidays.find((h) => h.id === 'corpus-domini')!;
    expect(corpus.dates['2026']).toBe('2026-06-04');
  });

  // Cantonal list (DFE, «Giorni festivi in Ticino», 2026 + 2027): 15 days,
  // San Giuseppe included, Good Friday NOT an official Ticino holiday.
  it('matches the 15 official Ticino holidays published by the Canton', () => {
    const ticinoIds = DATASET.holidays.filter((h) => h.ticino).map((h) => h.id).sort();
    expect(ticinoIds).toEqual([
      'ascensione', 'capodanno', 'corpus-domini', 'epifania', 'festa-lavoro', 'festa-nazionale',
      'assunzione', 'immacolata', 'lunedi-angelo', 'lunedi-pentecoste', 'natale', 'ognissanti',
      'pietro-paolo', 'san-giuseppe', 'santo-stefano',
    ].sort());
    expect(DATASET.holidays.some((h) => h.id === 'venerdi-santo')).toBe(false);
    const ticino2027 = Object.fromEntries(
      DATASET.holidays.filter((h) => h.ticino).map((h) => [h.id, h.dates['2027']]),
    );
    expect(ticino2027['san-giuseppe']).toBe('2027-03-19');
    expect(ticino2027['lunedi-angelo']).toBe('2027-03-29');
    expect(ticino2027['ascensione']).toBe('2027-05-06');
    expect(ticino2027['lunedi-pentecoste']).toBe('2027-05-17');
    expect(ticino2027['corpus-domini']).toBe('2027-05-27');
  });

  it('the committed JSON is the shared catalogue for its years (no drift)', () => {
    const rebuilt = buildHolidaysDataset(DATASET.meta.years, DATASET.meta.generatedAt);
    expect(DATASET).toEqual(rebuilt);
  });
});

describe('holidays — year rollover from the build date', () => {
  it('covers the current and the next calendar year at any build date', () => {
    const now = new Date();
    expect(holidayYearsFor(now)).toEqual([now.getUTCFullYear(), now.getUTCFullYear() + 1]);
    expect([now.getUTCFullYear(), now.getUTCFullYear() + 1]).toContain(holidayFocusYear(now));
  });

  it('leads with the current year until August and with the next one from September', () => {
    const y = new Date().getUTCFullYear();
    expect(holidayFocusYear(new Date(Date.UTC(y, 7, 31)))).toBe(y);
    expect(holidayFocusYear(new Date(Date.UTC(y, 8, 1)))).toBe(y + 1);
    expect(holidayFocusYear(new Date(Date.UTC(y, 0, 1)))).toBe(y);
  });

  it('renders title, H1 and the first table for the searched year', () => {
    const y = new Date().getUTCFullYear();
    const autumn = __renderHolidayPageForTest({ locale: 'it', page: 'ticino', dateStamp: `${y}-10-24` });
    expect(autumn.html).toContain(`<title>Giorni festivi e festività Ticino ${y + 1} e ${y}`);
    expect(autumn.html).toContain(`Giorni festivi in Ticino ${y + 1} e ${y}</h1>`);
    expect(autumn.html.indexOf(`Calendario festivi ${y + 1}`)).toBeLessThan(autumn.html.indexOf(`Calendario festivi ${y}"`));
    const spring = __renderHolidayPageForTest({ locale: 'it', page: 'ticino', dateStamp: `${y}-04-10` });
    expect(spring.html).toContain(`<title>Giorni festivi e festività Ticino ${y} e ${y + 1}`);
    // Next January the page moves on by itself: no manual refresh involved.
    const nextJanuary = __renderHolidayPageForTest({ locale: 'it', page: 'ticino', dateStamp: `${y + 1}-01-15` });
    expect(nextJanuary.html).toContain(`aria-label="Calendario festivi ${y + 2}"`);
    expect(nextJanuary.html).not.toContain(`aria-label="Calendario festivi ${y}"`);
  });

  it('cites the official cantonal source on every locale', () => {
    for (const locale of HOLIDAY_LOCALES) {
      const r = __renderHolidayPageForTest({ locale, page: 'ticino', dateStamp: '2026-10-24' });
      expect(r.html, locale).toContain('https://www4.ti.ch/dfe/de/uil/legge-lavoro/giorni-festivi-in-ticino-1');
    }
  });
});

describe('holidays landings — render smoke', () => {
  it('every page renders above the thin-content floor with canonical + h1', () => {
    for (const locale of HOLIDAY_LOCALES) {
      for (const page of HOLIDAY_PAGE_IDS) {
        const r = __renderHolidayPageForTest({ locale, page, dateStamp: '2026-07-19' });
        expect(r.wordCount, `${locale}/${page} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toContain('<h1');
        expectGenerationDateLabel(r.html, locale);
        expect(r.html).toContain(`https://frontaliereticino.ch${r.urlPath}`);
        expectIndexableWithLargePreview(r.html, `${locale}/${page}`);
      }
    }
  });

  it('ch-vs-it page names the non-coinciding days', () => {
    const r = __renderHolidayPageForTest({ locale: 'it', page: 'ch-vs-it', dateStamp: '2026-07-19' });
    expect(r.html).toContain('San Giuseppe');
    expect(r.html).not.toContain('Venerdì Santo');
    expect(r.html).toContain('Anniversario della Liberazione');
    expect((r.html.match(/<main\b/g) ?? []).length).toBe(1);
    expect(r.html).toContain('aria-label="Giorni festivi: Svizzera (Ticino) vs Italia');
  });

  it('gives both Ticino calendar tables explicit accessible names', () => {
    const r = __renderHolidayPageForTest({ locale: 'it', page: 'ticino', dateStamp: '2026-07-19' });

    expect((r.html.match(/<main\b/g) ?? []).length).toBe(1);
    expect(r.html).toContain('aria-label="Calendario festivi 2026"');
    expect(r.html).toContain('aria-label="Calendario festivi 2027"');
  });

  it('does not expose a null placeholder in the German editorial holiday copy', () => {
    const copy = SECTION_EDITORIAL['/tasse-e-pensione/festivita-ticino'].de.join(' ');
    expect(copy).toContain('keine Ferientage');
    expect(copy).not.toContain('null Ferientage');
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
