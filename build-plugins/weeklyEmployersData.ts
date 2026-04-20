/**
 * Weekly "Aziende che assumono" per-city Hub — pure data/path helpers.
 *
 * F5 — GSC evidence shows ~170 impressions/month across queries like
 * "aziende mendrisio che assumono", "stabio aziende che assumono",
 * "aziende ticino che assumono", "aziende chiasso che assumono" — ranking
 * positions 2.5-4 but near-zero CTR because the intent
 * "companies hiring in {city} this week" is not satisfied by existing
 * generic job listing pages.
 *
 * URL structure:
 *   IT regional:  /aziende-che-assumono/ticino/settimana-corrente/
 *                 /aziende-che-assumono/ticino/settimana-16-2026/
 *   IT per-city:  /aziende-che-assumono/{city}/settimana-corrente/
 *                 /aziende-che-assumono/{city}/settimana-16-2026/
 *   EN:           /en/companies-hiring/{city-or-ticino}/current-week/
 *                 /en/companies-hiring/{city-or-ticino}/week-16-2026/
 *   DE:           /de/unternehmen-einstellen/{city-or-ticino}/aktuelle-woche/
 *                 /de/unternehmen-einstellen/{city-or-ticino}/woche-16-2026/
 *   FR:           /fr/entreprises-recrutent/{city-or-ticino}/semaine-courante/
 *                 /fr/entreprises-recrutent/{city-or-ticino}/semaine-16-2026/
 *
 * This module exports:
 *   - City list (6 cities + 'ticino' regional hub)
 *   - Per-locale section slugs + current-week slug + archive slug prefixes
 *   - Path builders (current + archive) for any city × locale × ISO week
 *   - Path parser (used by services/router.ts to dispatch soft-nav)
 *   - WEEKLY_EMPLOYERS_ROUTES — preset list of all "current-week" canonical
 *     paths (7 cities × 4 locales = 28 paths) for the router table
 *
 * No I/O, no side effects — tests can import directly.
 */

export type WeeklyEmployersLocale = 'it' | 'en' | 'de' | 'fr';
export type WeeklyEmployersCity =
  | 'ticino'
  | 'lugano'
  | 'mendrisio'
  | 'chiasso'
  | 'stabio'
  | 'bellinzona'
  | 'locarno';

export const WEEKLY_EMPLOYERS_LOCALES: readonly WeeklyEmployersLocale[] = [
  'it',
  'en',
  'de',
  'fr',
] as const;

/** Ordered list: regional "ticino" hub first, then city hubs sorted by GSC priority. */
export const WEEKLY_EMPLOYERS_CITIES: readonly WeeklyEmployersCity[] = [
  'ticino',
  'lugano',
  'mendrisio',
  'chiasso',
  'stabio',
  'bellinzona',
  'locarno',
] as const;

/** City display name — proper nouns, same across all locales. */
export const WEEKLY_EMPLOYERS_CITY_DISPLAY: Record<WeeklyEmployersCity, string> = {
  ticino: 'Ticino',
  lugano: 'Lugano',
  mendrisio: 'Mendrisio',
  chiasso: 'Chiasso',
  stabio: 'Stabio',
  bellinzona: 'Bellinzona',
  locarno: 'Locarno',
};

/** Top-level section slug per locale. */
export const WEEKLY_EMPLOYERS_SECTION: Record<WeeklyEmployersLocale, string> = {
  it: 'aziende-che-assumono',
  en: 'companies-hiring',
  de: 'unternehmen-einstellen',
  fr: 'entreprises-recrutent',
};

/** Locale path prefix — Italian has no prefix. */
export const WEEKLY_EMPLOYERS_LOCALE_PREFIX: Record<WeeklyEmployersLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** "Current week" slug per locale. */
export const WEEKLY_EMPLOYERS_CURRENT_SLUG: Record<WeeklyEmployersLocale, string> = {
  it: 'settimana-corrente',
  en: 'current-week',
  de: 'aktuelle-woche',
  fr: 'semaine-courante',
};

/**
 * Archive slug *prefix* per locale.
 * Archive slug is `${prefix}-{NN}-{YYYY}` — e.g. IT "settimana-16-2026",
 * EN "week-16-2026", DE "woche-16-2026", FR "semaine-16-2026".
 */
export const WEEKLY_EMPLOYERS_ARCHIVE_PREFIX: Record<WeeklyEmployersLocale, string> = {
  it: 'settimana',
  en: 'week',
  de: 'woche',
  fr: 'semaine',
};

export const WEEKLY_EMPLOYERS_OG_LOCALE: Record<WeeklyEmployersLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Maximum number of past weeks that remain `index,follow`. Older archives go noindex. */
export const WEEKLY_EMPLOYERS_INDEXABLE_WEEKS = 12;

function joinPath(parts: readonly string[]): string {
  const nonEmpty = parts
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

/** Build canonical path for the "current week" hub for a given (locale, city). */
export function buildCurrentWeekPath(
  locale: WeeklyEmployersLocale,
  city: WeeklyEmployersCity,
): string {
  return joinPath([
    WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale],
    WEEKLY_EMPLOYERS_SECTION[locale],
    city,
    WEEKLY_EMPLOYERS_CURRENT_SLUG[locale],
  ]);
}

/** Build the archive slug (e.g. "settimana-16-2026") for (locale, weekNum, year). */
export function buildArchiveSlug(
  locale: WeeklyEmployersLocale,
  weekNum: number,
  year: number,
): string {
  const nn = String(weekNum).padStart(2, '0');
  return `${WEEKLY_EMPLOYERS_ARCHIVE_PREFIX[locale]}-${nn}-${year}`;
}

/** Build canonical path for an archive (past week) hub. */
export function buildArchiveWeekPath(
  locale: WeeklyEmployersLocale,
  city: WeeklyEmployersCity,
  weekNum: number,
  year: number,
): string {
  return joinPath([
    WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale],
    WEEKLY_EMPLOYERS_SECTION[locale],
    city,
    buildArchiveSlug(locale, weekNum, year),
  ]);
}

export interface WeeklyEmployersPath {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCity;
  variant: 'current' | 'archive';
  weekNum?: number;
  year?: number;
  path: string;
}

/** Enumerate every "current-week" path across locales × cities. */
export function listCurrentWeekPaths(): WeeklyEmployersPath[] {
  const out: WeeklyEmployersPath[] = [];
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    for (const city of WEEKLY_EMPLOYERS_CITIES) {
      out.push({
        locale,
        city,
        variant: 'current',
        path: buildCurrentWeekPath(locale, city),
      });
    }
  }
  return out;
}

/**
 * Router route table: canonical "current-week" URLs. Imported by
 * services/router.ts so unknown /aziende-che-assumono/... URLs resolve to
 * a known SPA tab (job-board) instead of 404 on back/forward nav.
 *
 * 4 locales × 7 cities = 28 paths.
 */
export const WEEKLY_EMPLOYERS_ROUTES: readonly string[] = listCurrentWeekPaths().map(
  (p) => p.path,
);

const WEEKLY_EMPLOYERS_ROUTE_SET: ReadonlySet<string> = new Set(WEEKLY_EMPLOYERS_ROUTES);

/** Regex matching an archive slug in any locale: captures week number + year. */
const ARCHIVE_SLUG_RE =
  /^(?:settimana|week|woche|semaine)-(0[1-9]|[1-4]\d|5[0-3])-(\d{4})$/;

/**
 * Parse an incoming URL path and return the match descriptor if it's a
 * weekly-employers hub (current or archive), else null.
 *
 * Examples that match:
 *   /aziende-che-assumono/ticino/settimana-corrente/
 *   /aziende-che-assumono/lugano/settimana-16-2026/
 *   /en/companies-hiring/mendrisio/current-week/
 *   /de/unternehmen-einstellen/chiasso/woche-42-2025/
 */
export function parseWeeklyEmployersPath(urlPath: string): {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCity;
  variant: 'current' | 'archive';
  weekNum?: number;
  year?: number;
} | null {
  if (!urlPath) return null;
  const leading = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const withSlash = leading.endsWith('/') ? leading : `${leading}/`;

  if (WEEKLY_EMPLOYERS_ROUTE_SET.has(withSlash)) {
    // Fast path — lookup in pre-computed set
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      for (const city of WEEKLY_EMPLOYERS_CITIES) {
        if (buildCurrentWeekPath(locale, city) === withSlash) {
          return { locale, city, variant: 'current' };
        }
      }
    }
  }

  // Archive paths: parse segments and match section + archive slug shape.
  const parts = withSlash.split('/').filter(Boolean);
  if (parts.length < 3) return null;

  // Detect locale prefix
  let idx = 0;
  let locale: WeeklyEmployersLocale = 'it';
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts[0] as WeeklyEmployersLocale;
    idx = 1;
  }

  const expectedSection = WEEKLY_EMPLOYERS_SECTION[locale];
  if (parts[idx] !== expectedSection) return null;

  const citySeg = parts[idx + 1];
  const tailSeg = parts[idx + 2];
  if (!citySeg || !tailSeg) return null;
  if (idx + 3 !== parts.length) return null;

  const city = WEEKLY_EMPLOYERS_CITIES.find((c) => c === citySeg);
  if (!city) return null;

  if (tailSeg === WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]) {
    return { locale, city, variant: 'current' };
  }

  const m = ARCHIVE_SLUG_RE.exec(tailSeg);
  if (!m) return null;
  // Also enforce locale prefix match against slug shape (e.g. IT → "settimana-")
  const expectedArchivePrefix = WEEKLY_EMPLOYERS_ARCHIVE_PREFIX[locale];
  if (!tailSeg.startsWith(`${expectedArchivePrefix}-`)) return null;

  const weekNum = Number.parseInt(m[1], 10);
  const year = Number.parseInt(m[2], 10);
  if (!Number.isFinite(weekNum) || !Number.isFinite(year)) return null;
  return { locale, city, variant: 'archive', weekNum, year };
}

/**
 * ISO-week helpers: compute the ISO 8601 week number and its associated
 * year (the "ISO week year" may differ from the calendar year at year
 * boundaries — e.g. 2026-01-01 falls in ISO week 2025-W53).
 *
 * Reference: ISO 8601 — weeks start on Monday, week 1 is the week
 * containing the first Thursday of the year.
 */
export function getIsoWeekAndYear(d: Date): { week: number; year: number } {
  // Copy date at UTC midnight to avoid DST shenanigans.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Monday=1…Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Nearest Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { week, year: date.getUTCFullYear() };
}

/** Compact key "YYYY-WW" used as snapshot filename / dict key. */
export function isoWeekKey(d: Date): string {
  const { week, year } = getIsoWeekAndYear(d);
  return `${year}-${String(week).padStart(2, '0')}`;
}

/** Is this path one of the 28 current-week URLs? */
export function isWeeklyEmployersPath(pathname: string): boolean {
  return parseWeeklyEmployersPath(pathname) !== null;
}
