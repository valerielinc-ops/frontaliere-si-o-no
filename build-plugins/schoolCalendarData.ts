/**
 * Ticino school calendars (DECS) — official dates + landing paths.
 *
 * ONE record per school year, copied from the official DECS PDF linked in
 * `sourcePdf` (index: {@link SCHOOL_CALENDAR_SOURCE_INDEX}). Nothing here is
 * estimated: a school year the DECS has not published yet has no record, and
 * the pages say so instead of guessing (see `latestPublishedSchoolYear`).
 *
 * Pages: `build-plugins/schoolCalendarLandingsPlugin.ts` emits one landing per
 * record from {@link FIRST_GENERATED_START_YEAR} on, in 4 locales. Adding the
 * next DECS record is the whole yearly rollover: route, sitemap, cross-links
 * between years and the link from the 2026/27 editorial page follow from it.
 *
 * The 2026/27 year keeps its existing hand-written landing
 * (`/vita-in-ticino/vacanze-scolastiche-ticino-2026/`, SECTION_EDITORIAL +
 * SEO_METADATA): it ranks for «calendario scolastico 2026/27» and this module
 * only links to it. Its record below is the same official data.
 *
 * Routes (Y = first calendar year of the school year):
 *   IT  /vita-in-ticino/vacanze-scolastiche-ticino-Y/
 *   EN  /en/living-in-ticino/school-holidays-ticino-Y/
 *   DE  /de/leben-im-tessin/schulferien-tessin-Y/
 *   FR  /fr/vivre-au-tessin/vacances-scolaires-tessin-Y/
 * (the same pattern the 2026 page already uses in the four locales).
 */

import { HOLIDAY_CATALOGUE } from './shared/ticinoHolidaysCatalog.mjs';

export const SCHOOL_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type SchoolLocale = (typeof SCHOOL_LOCALES)[number];

export const SCHOOL_CALENDAR_SOURCE_INDEX = 'https://www4.ti.ch/decs/cosa-facciamo/calendario-scolastico';

/** Cantonal holidays the DECS lists as school-closed days inside a school year. */
export type SchoolHolidayId =
  | 'immacolata'
  | 'san-giuseppe'
  | 'festa-lavoro'
  | 'ascensione'
  | 'lunedi-pentecoste'
  | 'corpus-domini';

const SCHOOL_HOLIDAY_IDS: readonly SchoolHolidayId[] = [
  'immacolata', 'san-giuseppe', 'festa-lavoro', 'ascensione', 'lunedi-pentecoste', 'corpus-domini',
];

/** Localized names, read from the shared Ticino holiday catalogue (single source). */
export const SCHOOL_HOLIDAY_NAMES = Object.fromEntries(
  SCHOOL_HOLIDAY_IDS.map((id) => {
    const holiday = HOLIDAY_CATALOGUE.find((h: { id: string }) => h.id === id);
    if (!holiday) throw new Error(`[school-calendar] holiday ${id} missing from ticinoHolidaysCatalog`);
    return [id, holiday.name as Record<SchoolLocale, string>];
  }),
) as Record<SchoolHolidayId, Record<SchoolLocale, string>>;

/** Inclusive ISO date range («dal – al compresi» in the DECS document). */
export interface SchoolDateRange {
  readonly from: string;
  readonly to: string;
}

export interface SchoolYearCalendar {
  /** First calendar year of the school year (2027 → 2027/28). */
  readonly startYear: number;
  readonly firstDay: string;
  readonly lastDay: string;
  readonly autumn: SchoolDateRange;
  readonly christmas: SchoolDateRange;
  readonly carnival: SchoolDateRange;
  readonly easter: SchoolDateRange;
  /** «Sono inoltre giorni festivi in Ticino» — holidays inside the school year. */
  readonly closedHolidays: ReadonlyArray<{ readonly id: SchoolHolidayId; readonly date: string }>;
  /** «È inoltre giorno di vacanza …» — extra days off (bridges). */
  readonly extraDaysOff: readonly string[];
  readonly sourcePdf: string;
}

const PDF_BASE = 'https://www4.ti.ch/fileadmin/DECS/calendario_scolastico';

/** Official DECS calendars, read from the PDFs on 2026-10-24. Sorted by year. */
export const SCHOOL_CALENDARS: readonly SchoolYearCalendar[] = [
  {
    startYear: 2026,
    firstDay: '2026-08-31',
    lastDay: '2027-06-16',
    autumn: { from: '2026-10-31', to: '2026-11-08' },
    christmas: { from: '2026-12-24', to: '2027-01-06' },
    carnival: { from: '2027-02-06', to: '2027-02-14' },
    easter: { from: '2027-03-26', to: '2027-04-04' },
    closedHolidays: [
      { id: 'immacolata', date: '2026-12-08' },
      { id: 'san-giuseppe', date: '2027-03-19' },
      { id: 'ascensione', date: '2027-05-06' },
      { id: 'lunedi-pentecoste', date: '2027-05-17' },
      { id: 'corpus-domini', date: '2027-05-27' },
    ],
    extraDaysOff: ['2027-05-07'],
    sourcePdf: `${PDF_BASE}/Calendario_scolastico_2026_2027.pdf`,
  },
  {
    startYear: 2027,
    firstDay: '2027-08-30',
    lastDay: '2028-06-14',
    autumn: { from: '2027-10-30', to: '2027-11-07' },
    christmas: { from: '2027-12-24', to: '2028-01-09' },
    carnival: { from: '2028-02-26', to: '2028-03-05' },
    easter: { from: '2028-04-14', to: '2028-04-23' },
    closedHolidays: [
      { id: 'immacolata', date: '2027-12-08' },
      { id: 'festa-lavoro', date: '2028-05-01' },
      { id: 'ascensione', date: '2028-05-25' },
      { id: 'lunedi-pentecoste', date: '2028-06-05' },
    ],
    extraDaysOff: ['2028-01-07', '2028-05-26'],
    sourcePdf: `${PDF_BASE}/Calendario_scolastico_2027-2028.pdf`,
  },
  {
    startYear: 2028,
    firstDay: '2028-08-30',
    lastDay: '2029-06-15',
    autumn: { from: '2028-10-28', to: '2028-11-05' },
    christmas: { from: '2028-12-23', to: '2029-01-07' },
    carnival: { from: '2029-02-10', to: '2029-02-18' },
    easter: { from: '2029-03-30', to: '2029-04-06' },
    closedHolidays: [
      { id: 'immacolata', date: '2028-12-08' },
      { id: 'san-giuseppe', date: '2029-03-19' },
      { id: 'festa-lavoro', date: '2029-05-01' },
      { id: 'ascensione', date: '2029-05-10' },
      { id: 'lunedi-pentecoste', date: '2029-05-21' },
      { id: 'corpus-domini', date: '2029-05-31' },
    ],
    extraDaysOff: [],
    sourcePdf: `${PDF_BASE}/Calendario_scolastico_2028-2029.pdf`,
  },
  {
    startYear: 2029,
    firstDay: '2029-09-03',
    lastDay: '2030-06-19',
    autumn: { from: '2029-10-27', to: '2029-11-04' },
    christmas: { from: '2029-12-22', to: '2030-01-06' },
    carnival: { from: '2030-03-02', to: '2030-03-10' },
    easter: { from: '2030-04-19', to: '2030-04-28' },
    closedHolidays: [
      { id: 'san-giuseppe', date: '2030-03-19' },
      { id: 'festa-lavoro', date: '2030-05-01' },
      { id: 'ascensione', date: '2030-05-30' },
      { id: 'lunedi-pentecoste', date: '2030-06-10' },
    ],
    extraDaysOff: ['2030-05-31'],
    sourcePdf: `${PDF_BASE}/Calendario_scolastico_2029-2030.pdf`,
  },
];

/** Years before this keep their hand-written landing (2026/27); from here the plugin emits. */
export const FIRST_GENERATED_START_YEAR = 2027;

export function schoolCalendarFor(startYear: number): SchoolYearCalendar | undefined {
  return SCHOOL_CALENDARS.find((c) => c.startYear === startYear);
}

/** «2027/28» */
export function schoolYearLabel(startYear: number): string {
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The most recent school year the DECS has published. */
export function latestPublishedSchoolYear(): number {
  return SCHOOL_CALENDARS[SCHOOL_CALENDARS.length - 1].startYear;
}

/**
 * Where a school year stands at `now` (UTC date compare on ISO strings):
 * before its first day it is upcoming, after its last day (summer included
 * until the next first day) it is over.
 */
export function schoolYearStatus(cal: SchoolYearCalendar, now: Date): 'upcoming' | 'current' | 'past' {
  const today = now.toISOString().slice(0, 10);
  if (today < cal.firstDay) return 'upcoming';
  if (today > cal.lastDay) return 'past';
  return 'current';
}

const LOCALE_PREFIX: Record<SchoolLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const SECTION: Record<SchoolLocale, string> = {
  it: 'vita-in-ticino',
  en: 'living-in-ticino',
  de: 'leben-im-tessin',
  fr: 'vivre-au-tessin',
};
const SLUG: Record<SchoolLocale, string> = {
  it: 'vacanze-scolastiche-ticino',
  en: 'school-holidays-ticino',
  de: 'schulferien-tessin',
  fr: 'vacances-scolaires-tessin',
};

export function buildSchoolCalendarPath(locale: SchoolLocale, startYear: number): string {
  return `${LOCALE_PREFIX[locale]}/${SECTION[locale]}/${SLUG[locale]}-${startYear}/`;
}

/** School years this build emits as generated landings. */
export const GENERATED_SCHOOL_YEARS: readonly number[] = SCHOOL_CALENDARS
  .map((c) => c.startYear)
  .filter((y) => y >= FIRST_GENERATED_START_YEAR);

export const SCHOOL_CALENDAR_LANDING_ROUTES: readonly string[] = SCHOOL_LOCALES.flatMap((locale) =>
  GENERATED_SCHOOL_YEARS.map((y) => buildSchoolCalendarPath(locale, y)),
);

const ROUTE_INDEX = new Map<string, { locale: SchoolLocale; startYear: number }>(
  SCHOOL_LOCALES.flatMap((locale) =>
    GENERATED_SCHOOL_YEARS.map((startYear) => [buildSchoolCalendarPath(locale, startYear), { locale, startYear }] as const),
  ),
);

export function parseSchoolCalendarLandingPath(
  pathname: string,
): { locale: SchoolLocale; startYear: number } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return ROUTE_INDEX.get(normalized) ?? null;
}

