/**
 * Ticino school-calendar landings: DECS data integrity, routes, render and
 * the yearly rollover driven by the data (no hand-written page per year).
 */
import { describe, it, expect } from 'vitest';
import {
  FIRST_GENERATED_START_YEAR,
  GENERATED_SCHOOL_YEARS,
  SCHOOL_CALENDARS,
  SCHOOL_CALENDAR_LANDING_ROUTES,
  SCHOOL_LOCALES,
  buildSchoolCalendarPath,
  latestPublishedSchoolYear,
  parseSchoolCalendarLandingPath,
  schoolCalendarFor,
  schoolYearLabel,
  schoolYearStatus,
} from '@/build-plugins/schoolCalendarData';
import { renderSchoolCalendarSource, renderSchoolYearLinks } from '@/build-plugins/schoolCalendarLinks';
import { __renderSchoolCalendarPageForTest } from '@/build-plugins/schoolCalendarLandingsPlugin';
import { MIN_INDEXABLE_WORDS } from '@/build-plugins/constants';
import { parsePath } from '@/services/router';

const weekday = (iso: string): number => new Date(`${iso}T12:00:00Z`).getUTCDay();
const shift = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe('school calendars — DECS data', () => {
  it('is sorted, contiguous and internally ordered', () => {
    SCHOOL_CALENDARS.forEach((c, i) => {
      if (i > 0) expect(c.startYear).toBe(SCHOOL_CALENDARS[i - 1].startYear + 1);
      const seq = [c.firstDay, c.autumn.from, c.autumn.to, c.christmas.from, c.christmas.to, c.carnival.from, c.carnival.to, c.easter.from, c.easter.to, c.lastDay];
      expect([...seq].sort(), String(c.startYear)).toEqual(seq);
      for (const h of [...c.closedHolidays.map((x) => x.date), ...c.extraDaysOff]) {
        expect(h > c.firstDay && h < c.lastDay, `${c.startYear} ${h}`).toBe(true);
      }
      expect(c.sourcePdf).toMatch(/^https:\/\/www4\.ti\.ch\/fileadmin\/DECS\/calendario_scolastico\/.+\.pdf$/);
    });
  });

  // Weekdays as printed in the official PDFs: a typo in a date would break them.
  it('matches the weekdays printed in the DECS documents', () => {
    const c27 = schoolCalendarFor(2027)!;
    expect(weekday(c27.firstDay)).toBe(1); // lunedì 30 agosto 2027
    expect(weekday(c27.lastDay)).toBe(3); // mercoledì 14 giugno 2028
    expect(c27.extraDaysOff.map(weekday)).toEqual([5, 5]); // venerdì 7 gennaio e 26 maggio 2028
    expect(weekday(c27.closedHolidays.find((h) => h.id === 'ascensione')!.date)).toBe(4);
    const c28 = schoolCalendarFor(2028)!;
    expect(weekday(c28.firstDay)).toBe(3); // mercoledì 30 agosto 2028
    expect(weekday(c28.lastDay)).toBe(5); // venerdì 15 giugno 2029
    const c29 = schoolCalendarFor(2029)!;
    expect(weekday(c29.firstDay)).toBe(1); // lunedì 3 settembre 2029
    expect(weekday(c29.lastDay)).toBe(3); // mercoledì 19 giugno 2030
    const c26 = schoolCalendarFor(2026)!;
    expect(weekday(c26.firstDay)).toBe(1); // lunedì 31 agosto 2026
    expect(c26.lastDay).toBe('2027-06-16');
  });
});

describe('school calendars — routes', () => {
  it('generates one route per locale for every published year from 2027/28', () => {
    expect(GENERATED_SCHOOL_YEARS[0]).toBe(FIRST_GENERATED_START_YEAR);
    expect(GENERATED_SCHOOL_YEARS).not.toContain(2026);
    expect(SCHOOL_CALENDAR_LANDING_ROUTES).toHaveLength(GENERATED_SCHOOL_YEARS.length * SCHOOL_LOCALES.length);
    for (const r of SCHOOL_CALENDAR_LANDING_ROUTES) expect(r.endsWith('/')).toBe(true);
  });

  it('keeps the URL pattern of the 2026/27 page and round-trips', () => {
    expect(buildSchoolCalendarPath('it', 2026)).toBe('/vita-in-ticino/vacanze-scolastiche-ticino-2026/');
    expect(buildSchoolCalendarPath('it', 2027)).toBe('/vita-in-ticino/vacanze-scolastiche-ticino-2027/');
    expect(buildSchoolCalendarPath('en', 2027)).toBe('/en/living-in-ticino/school-holidays-ticino-2027/');
    expect(buildSchoolCalendarPath('de', 2027)).toBe('/de/leben-im-tessin/schulferien-tessin-2027/');
    expect(buildSchoolCalendarPath('fr', 2027)).toBe('/fr/vivre-au-tessin/vacances-scolaires-tessin-2027/');
    expect(parseSchoolCalendarLandingPath('/vita-in-ticino/vacanze-scolastiche-ticino-2027')).toEqual({ locale: 'it', startYear: 2027 });
    // 2026 stays on its hand-written route; an unpublished year has no route.
    expect(parseSchoolCalendarLandingPath('/vita-in-ticino/vacanze-scolastiche-ticino-2026/')).toBeNull();
    expect(parseSchoolCalendarLandingPath(buildSchoolCalendarPath('it', latestPublishedSchoolYear() + 1))).toBeNull();
  });

  it('routes the generated pages to a static overlay in the SPA', () => {
    const parsed = parsePath('/en/living-in-ticino/school-holidays-ticino-2027/');
    expect(parsed.locale).toBe('en');
    expect(parsed.route.staticOverlay).toBe(true);
    expect(parsed.route.activeTab).toBe('vita');
  });
});

describe('school calendars — render', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('renders every generated page above the thin floor, with the searched year in the title', () => {
    for (const startYear of GENERATED_SCHOOL_YEARS) {
      for (const locale of SCHOOL_LOCALES) {
        const r = __renderSchoolCalendarPageForTest({ locale, startYear, dateStamp: today });
        expect(r.wordCount, `${locale}/${startYear}`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toMatch(new RegExp(`<title>[^<]*${schoolYearLabel(startYear).replace('/', '\\/')}`));
        expect(r.html).toMatch(new RegExp(`rel="?canonical"? href="?https://frontaliereticino\\.ch${r.urlPath}`));
        expect(r.html).toContain(schoolCalendarFor(startYear)!.sourcePdf);
        expect((r.html.match(/<h1\b/g) ?? []).length).toBe(1);
      }
    }
  });

  it('labels the year from the build date (relative to the DECS dates)', () => {
    const c = schoolCalendarFor(FIRST_GENERATED_START_YEAR)!;
    const at = (d: string) => __renderSchoolCalendarPageForTest({ locale: 'it', startYear: c.startYear, dateStamp: d }).html;
    expect(at(shift(c.firstDay, -1))).toContain('Anno scolastico in arrivo');
    expect(at(c.firstDay)).toContain('Anno scolastico in corso');
    expect(at(shift(c.lastDay, 1))).toContain('Anno scolastico concluso');
    expect(schoolYearStatus(c, new Date(`${shift(c.lastDay, 1)}T12:00:00Z`))).toBe('past');
  });

  it('says when the next official calendar does not exist yet instead of estimating it', () => {
    const last = latestPublishedSchoolYear();
    const r = __renderSchoolCalendarPageForTest({ locale: 'it', startYear: last, dateStamp: today });
    expect(r.html).toContain(`che il DECS non ha ancora pubblicato`);
    expect(r.html).toContain(`fino all’anno ${schoolYearLabel(last)}`);
    const earlier = __renderSchoolCalendarPageForTest({ locale: 'it', startYear: FIRST_GENERATED_START_YEAR, dateStamp: today });
    expect(earlier.html).not.toContain('che il DECS non ha ancora pubblicato');
  });

  it('emits hreflang only for the locales the build writes', () => {
    const none = __renderSchoolCalendarPageForTest({ locale: 'it', startYear: 2027, dateStamp: today });
    expect(none.html).not.toMatch(/hreflang="?de/);
    const all = __renderSchoolCalendarPageForTest({ locale: 'it', startYear: 2027, dateStamp: today, eligibleLocales: new Set(SCHOOL_LOCALES) });
    expect(all.html).toMatch(/hreflang="?de"? href="?https:\/\/frontaliereticino\.ch\/de\/leben-im-tessin\/schulferien-tessin-2027\//);
  });
});

describe('school calendars — links from the 2026/27 page', () => {
  it('links every other published year, following the data', () => {
    const html = renderSchoolYearLinks('it', 2026);
    for (const y of GENERATED_SCHOOL_YEARS) expect(html).toContain(`href="${buildSchoolCalendarPath('it', y)}"`);
    expect(html).not.toContain('vacanze-scolastiche-ticino-2026/');
    expect(html).toContain('Vacanze scolastiche 2027/28');
  });

  it('cites the official 2026/27 DECS PDF', () => {
    expect(renderSchoolCalendarSource('it', 2026)).toContain('href="https://www4.ti.ch/fileadmin/DECS/calendario_scolastico/Calendario_scolastico_2026_2027.pdf"');
    expect(renderSchoolCalendarSource('de', 2026)).toContain('Schulkalender 2026/27');
  });
});
