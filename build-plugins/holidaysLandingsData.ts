/**
 * Frontaliere public-holiday landings (#4480) — slug tables + path matchers.
 *
 * 2 page types × 4 locales = 8 static HTML pages:
 *
 *   'ticino'   — official Ticino / Switzerland holiday calendar (this year + next)
 *   'ch-vs-it' — Switzerland (Ticino) vs Italy comparison: which days do NOT
 *                coincide (the frontaliere differentiator) + bridge days
 *
 * Routes:
 *   IT  /giorni-festivi-ticino/             · /giorni-festivi-svizzera-italia/
 *   EN  /en/public-holidays-ticino/         · /en/public-holidays-switzerland-italy/
 *   DE  /de/feiertage-tessin/               · /de/feiertage-schweiz-italien/
 *   FR  /fr/jours-feries-tessin/            · /fr/jours-feries-suisse-italie/
 *
 * Router consumes {@link HOLIDAY_LANDING_ROUTES} + {@link parseHolidaysLandingPath}
 * for `staticOverlay: true` matching (same pattern as costOfLivingLandingsData).
 */

export const HOLIDAY_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type HolidayLocale = (typeof HOLIDAY_LOCALES)[number];

export const HOLIDAY_PAGE_IDS = ['ticino', 'ch-vs-it'] as const;
export type HolidayPageId = (typeof HOLIDAY_PAGE_IDS)[number];

const LOCALE_PREFIX: Record<HolidayLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Localised slug (no leading/trailing slash) per page type. */
const SLUG: Record<HolidayPageId, Record<HolidayLocale, string>> = {
  ticino: {
    it: 'giorni-festivi-ticino',
    en: 'public-holidays-ticino',
    de: 'feiertage-tessin',
    fr: 'jours-feries-tessin',
  },
  'ch-vs-it': {
    it: 'giorni-festivi-svizzera-italia',
    en: 'public-holidays-switzerland-italy',
    de: 'feiertage-schweiz-italien',
    fr: 'jours-feries-suisse-italie',
  },
};

export function buildHolidaysLandingPath(locale: HolidayLocale, page: HolidayPageId): string {
  return `${LOCALE_PREFIX[locale]}/${SLUG[page][locale]}/`.replace(/\/+/g, '/');
}

/** Flat list of all 8 canonical paths (4 locales × 2 page types). */
export const HOLIDAY_LANDING_ROUTES: readonly string[] = HOLIDAY_LOCALES.flatMap((loc) =>
  HOLIDAY_PAGE_IDS.map((id) => buildHolidaysLandingPath(loc, id)),
);

export function parseHolidaysLandingPath(
  pathname: string,
): { locale: HolidayLocale; page: HolidayPageId } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of HOLIDAY_LOCALES) {
    for (const page of HOLIDAY_PAGE_IDS) {
      if (buildHolidaysLandingPath(locale, page) === normalized) {
        return { locale, page };
      }
    }
  }
  return null;
}

export function isHolidaysLandingPath(pathname: string): boolean {
  return parseHolidaysLandingPath(pathname) !== null;
}

// ── Dataset shape (data/seo/frontaliere-holidays.json) ────────────────────

export interface HolidayRecord {
  readonly id: string;
  readonly name: Record<HolidayLocale, string>;
  readonly ticino: boolean;
  readonly italy: boolean;
  readonly swissFederal: boolean;
  readonly coincidence: 'both' | 'ticino-only' | 'italy-only';
  readonly dates: Record<string, string>;
}

export interface HolidaysDataset {
  readonly meta: {
    readonly description: string;
    readonly source: string;
    readonly refreshScript: string;
    readonly refreshCadence: string;
    readonly years: readonly number[];
    readonly generatedAt: string;
  };
  readonly holidays: readonly HolidayRecord[];
}
