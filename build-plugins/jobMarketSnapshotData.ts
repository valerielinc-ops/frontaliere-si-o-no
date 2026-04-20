/**
 * Job-market snapshot page data: locale slug maps, path builders, and the
 * route enumeration consumed by services/router.ts.
 *
 * F4 — Weekly Job Market Snapshot. A small, self-contained data module so
 * the plugin and the router can share a single source of truth for URL
 * shape without either file pulling in the heavier plugin logic.
 *
 * URL structure (all trailing-slash canonical):
 *  - Hub (evergreen):
 *      IT → /mercato-lavoro-ticino/
 *      EN → /en/ticino-job-market/
 *      DE → /de/tessiner-arbeitsmarkt/
 *      FR → /fr/marche-travail-tessin/
 *  - Weekly archive (ISO week):
 *      IT → /mercato-lavoro-ticino/settimana-16-2026/
 *      EN → /en/ticino-job-market/week-16-2026/
 *      DE → /de/tessiner-arbeitsmarkt/woche-16-2026/
 *      FR → /fr/marche-travail-tessin/semaine-16-2026/
 *  - Monthly aggregate:
 *      IT → /mercato-lavoro-ticino/aprile-2026/
 *      EN → /en/ticino-job-market/april-2026/
 *      DE → /de/tessiner-arbeitsmarkt/april-2026/
 *      FR → /fr/marche-travail-tessin/avril-2026/
 */

export type JobMarketSnapshotLocale = 'it' | 'en' | 'de' | 'fr';

export const JOB_MARKET_SNAPSHOT_LOCALES: readonly JobMarketSnapshotLocale[] = [
  'it',
  'en',
  'de',
  'fr',
] as const;

/** Section (hub) slug per locale — evergreen landing root. */
export const JOB_MARKET_SECTION_SLUG: Record<JobMarketSnapshotLocale, string> = {
  it: 'mercato-lavoro-ticino',
  en: 'ticino-job-market',
  de: 'tessiner-arbeitsmarkt',
  fr: 'marche-travail-tessin',
};

/** Locale URL prefix ("" for IT, "/en", "/de", "/fr"). */
export const JOB_MARKET_LOCALE_PREFIX: Record<JobMarketSnapshotLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** OG locale codes. */
export const JOB_MARKET_OG_LOCALE: Record<JobMarketSnapshotLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Breadcrumb / hub display name per locale. */
export const JOB_MARKET_HUB_NAME: Record<JobMarketSnapshotLocale, string> = {
  it: 'Mercato del lavoro in Ticino',
  en: 'Ticino job market',
  de: 'Tessiner Arbeitsmarkt',
  fr: 'Marché du travail au Tessin',
};

/** Week-prefix keyword per locale (e.g. "settimana-16-2026" / "week-16-2026"). */
export const JOB_MARKET_WEEK_PREFIX: Record<JobMarketSnapshotLocale, string> = {
  it: 'settimana',
  en: 'week',
  de: 'woche',
  fr: 'semaine',
};

/** Month names per locale, 1-indexed (index 0 is a placeholder). */
export const JOB_MARKET_MONTH_NAMES: Record<
  JobMarketSnapshotLocale,
  ReadonlyArray<string>
> = {
  it: [
    '',
    'gennaio',
    'febbraio',
    'marzo',
    'aprile',
    'maggio',
    'giugno',
    'luglio',
    'agosto',
    'settembre',
    'ottobre',
    'novembre',
    'dicembre',
  ],
  en: [
    '',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ],
  de: [
    '',
    'januar',
    'februar',
    'maerz',
    'april',
    'mai',
    'juni',
    'juli',
    'august',
    'september',
    'oktober',
    'november',
    'dezember',
  ],
  fr: [
    '',
    'janvier',
    'fevrier',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'aout',
    'septembre',
    'octobre',
    'novembre',
    'decembre',
  ],
};

// ── Helpers ───────────────────────────────────────────────────

function joinPath(parts: ReadonlyArray<string>): string {
  const nonEmpty = parts
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

/**
 * ISO 8601 week number + ISO week year for a given Date (UTC-based).
 * ISO weeks start on Monday; week 1 contains the year's first Thursday.
 */
export function getIsoWeek(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of the current ISO week
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** Monday (inclusive) UTC date for the given ISO year/week. */
export function mondayOfIsoWeek(isoYear: number, isoWeek: number): Date {
  // January 4th is always in ISO week 1
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const result = new Date(week1Monday.getTime());
  result.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return result;
}

/** Sunday (inclusive) UTC date for the given ISO year/week. */
export function sundayOfIsoWeek(isoYear: number, isoWeek: number): Date {
  const mon = mondayOfIsoWeek(isoYear, isoWeek);
  const sun = new Date(mon.getTime());
  sun.setUTCDate(mon.getUTCDate() + 6);
  return sun;
}

// ── Path builders ──────────────────────────────────────────────

export function buildHubPath(locale: JobMarketSnapshotLocale): string {
  return joinPath([JOB_MARKET_LOCALE_PREFIX[locale], JOB_MARKET_SECTION_SLUG[locale]]);
}

export function buildWeeklyPath(
  locale: JobMarketSnapshotLocale,
  isoYear: number,
  isoWeek: number,
): string {
  const weekSlug = `${JOB_MARKET_WEEK_PREFIX[locale]}-${String(isoWeek).padStart(2, '0')}-${isoYear}`;
  return joinPath([
    JOB_MARKET_LOCALE_PREFIX[locale],
    JOB_MARKET_SECTION_SLUG[locale],
    weekSlug,
  ]);
}

export function buildMonthlyPath(
  locale: JobMarketSnapshotLocale,
  year: number,
  /** 1-indexed month (1–12). */
  month: number,
): string {
  if (month < 1 || month > 12) {
    throw new RangeError(`invalid month ${month}; must be 1-12`);
  }
  const monthName = JOB_MARKET_MONTH_NAMES[locale][month];
  const monthSlug = `${monthName}-${year}`;
  return joinPath([
    JOB_MARKET_LOCALE_PREFIX[locale],
    JOB_MARKET_SECTION_SLUG[locale],
    monthSlug,
  ]);
}

// ── Route enumeration ─────────────────────────────────────────

/**
 * The hub routes are always known statically. Weekly and monthly routes
 * are data-dependent so we expose a predicate for the router rather than
 * a static list.
 */
export const JOB_MARKET_SNAPSHOT_ROUTES: readonly string[] = JOB_MARKET_SNAPSHOT_LOCALES.map(
  (loc) => buildHubPath(loc),
);

const HUB_ROUTE_SET: ReadonlySet<string> = new Set(JOB_MARKET_SNAPSHOT_ROUTES);

const WEEK_PATTERN = /^(settimana|week|woche|semaine)-(\d{1,2})-(\d{4})$/;

/**
 * Recognise any job-market-snapshot canonical URL (hub, weekly archive, or
 * monthly aggregate) across all locales. Accepts paths with or without a
 * trailing slash.
 */
export function isJobMarketSnapshotPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  if (HUB_ROUTE_SET.has(normalised)) return true;
  // Strip leading/trailing slashes and inspect segments
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  // Optional locale prefix
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  const sectionCandidate = parts[idx];
  const sectionMatchesLocale = (JOB_MARKET_SNAPSHOT_LOCALES as ReadonlyArray<JobMarketSnapshotLocale>).some(
    (loc) => JOB_MARKET_SECTION_SLUG[loc] === sectionCandidate,
  );
  if (!sectionMatchesLocale) return false;
  const sub = parts[idx + 1];
  if (!sub) return true; // hub (shouldn't happen since HUB_ROUTE_SET already caught it, but safe)
  if (WEEK_PATTERN.test(sub)) return true;
  // Month form: <month-name>-YYYY
  const monthMatch = /^([a-z]+)-(\d{4})$/.exec(sub);
  if (monthMatch) {
    const monthName = monthMatch[1];
    const allMonthNames = new Set<string>();
    for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const name of JOB_MARKET_MONTH_NAMES[loc]) {
        if (name) allMonthNames.add(name);
      }
    }
    if (allMonthNames.has(monthName)) return true;
  }
  return false;
}

/**
 * Parse an ISO week slug like "settimana-16-2026" / "week-16-2026" → { year, week }.
 * Returns null if the slug is not a valid week slug.
 */
export function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const m = WEEK_PATTERN.exec(slug);
  if (!m) return null;
  const week = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isFinite(week) || week < 1 || week > 53) return null;
  if (!Number.isFinite(year) || year < 2020 || year > 2100) return null;
  return { year, week };
}

/**
 * Parse a month slug like "aprile-2026" / "april-2026" → { year, month } where
 * month is 1-12. Returns null if the slug does not map to any known localised
 * month name.
 */
export function parseMonthSlug(slug: string): { year: number; month: number } | null {
  const m = /^([a-z]+)-(\d{4})$/.exec(slug);
  if (!m) return null;
  const name = m[1];
  const year = Number(m[2]);
  if (!Number.isFinite(year) || year < 2020 || year > 2100) return null;
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) {
    const idx = JOB_MARKET_MONTH_NAMES[loc].indexOf(name);
    if (idx >= 1) return { year, month: idx };
  }
  return null;
}
