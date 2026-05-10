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

/**
 * Detect the top-hub section root for the weekly-employers feature.
 * Matches `/aziende-che-assumono/` (IT), `/en/companies-hiring/`,
 * `/de/unternehmen-einstellen/`, `/fr/entreprises-recrutent/`.
 *
 * Returns the locale on match, else null. Used by `services/router.ts`
 * so the SPA hydration recognises the path as a static-overlay job-board
 * route instead of falling back to the calculator landing.
 */
export function parseWeeklyEmployersTopHubPath(
  urlPath: string,
): { locale: WeeklyEmployersLocale } | null {
  if (!urlPath) return null;
  const leading = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const withSlash = leading.endsWith('/') ? leading : `${leading}/`;
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    const prefix = WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale];
    const section = WEEKLY_EMPLOYERS_SECTION[locale];
    const expected = `${prefix}/${section}/`.replace(/\/+/g, '/');
    if (withSlash === expected) return { locale };
  }
  return null;
}

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

// ─────────────────────────────────────────────────────────────────────
// D-2 Expansion B — per-company × per-city hubs (F5 sub-feature).
//
// URL pattern (current):
//   IT:  /aziende-che-assumono/{city}/{company-slug}/settimana-corrente/
//   EN:  /en/companies-hiring/{city}/{company-slug}/current-week/
//   DE:  /de/unternehmen-einstellen/{city}/{company-slug}/aktuelle-woche/
//   FR:  /fr/entreprises-recrutent/{city}/{company-slug}/semaine-courante/
//
// Archives mirror the section-level archive slug:
//   IT:  /aziende-che-assumono/{city}/{company-slug}/settimana-16-2026/
//
// The regional "ticino" hub is SKIPPED for per-company pages because the
// city coverage (lugano/mendrisio/...) already aggregates the same data
// and a duplicate Ticino-wide per-company page would be low-value.
// ─────────────────────────────────────────────────────────────────────

/** Cities eligible for company-city pages (regional "ticino" hub excluded). */
export type WeeklyEmployersCompanyCity = Exclude<WeeklyEmployersCity, 'ticino'>;

export const WEEKLY_EMPLOYERS_COMPANY_CITY_LIST: readonly WeeklyEmployersCompanyCity[] = [
  'lugano',
  'mendrisio',
  'chiasso',
  'stabio',
  'bellinzona',
  'locarno',
] as const;

/** Hard gate: min active jobs for a company to qualify for a per-company × per-city page. */
export const MIN_JOBS_PER_COMPANY_IN_CITY = 3;

/**
 * Returns true iff a (company, city) record has enough active jobs to deserve
 * a dedicated per-company × per-city SEO page.
 *
 * Single source of truth for the "is this pair shippable?" question — the page
 * generator AND every link/sitemap emitter must funnel through this predicate
 * so we never emit `<a href="...">` or sitemap `<loc>` entries pointing at
 * paths the page generator will refuse to materialise.
 */
export function companyCityMeetsThreshold(
  rec: Readonly<{ active: number }>,
): boolean {
  return rec.active >= MIN_JOBS_PER_COMPANY_IN_CITY;
}

/** Per-build cap so the sitemap can't balloon if a crawler mis-aggregates. */
export const MAX_COMPANY_CITY_PAGES_PER_BUILD = 1500;

/**
 * Canonicalise a company name + optional companyKey into a URL-safe slug.
 * Mirrors the build-side `canonicalCompanySlugBuild` used by
 * jobsSeoPagesPlugin.ts (Lidl special-case + ASCII slugify).
 */
export function canonicalCompanySlug(
  company: string,
  companyKey?: string,
): string {
  const norm = (s: string): string =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const keyNorm = norm(companyKey || '');
  const nameNorm = norm(company);
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  // Fall back to slugified company name.
  return norm(company).replace(/\s+/g, '-');
}

/**
 * Build canonical path for the "current week" company-city hub.
 * Example: /aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/
 */
export function buildCompanyCityCurrentPath(
  locale: WeeklyEmployersLocale,
  city: WeeklyEmployersCompanyCity,
  companySlug: string,
): string {
  return joinPath([
    WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale],
    WEEKLY_EMPLOYERS_SECTION[locale],
    city,
    companySlug,
    WEEKLY_EMPLOYERS_CURRENT_SLUG[locale],
  ]);
}

/** Build canonical path for an archive company-city page. */
export function buildCompanyCityArchivePath(
  locale: WeeklyEmployersLocale,
  city: WeeklyEmployersCompanyCity,
  companySlug: string,
  weekNum: number,
  year: number,
): string {
  return joinPath([
    WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale],
    WEEKLY_EMPLOYERS_SECTION[locale],
    city,
    companySlug,
    buildArchiveSlug(locale, weekNum, year),
  ]);
}

const COMPANY_CITY_SET: ReadonlySet<WeeklyEmployersCompanyCity> = new Set(
  WEEKLY_EMPLOYERS_COMPANY_CITY_LIST,
);

/** Parsed descriptor for a /aziende-che-assumono/{city}/{company}/{when}/ URL. */
export interface WeeklyEmployersCompanyCityParsed {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  variant: 'current' | 'archive';
  weekNum?: number;
  year?: number;
}

/**
 * Parse a company-city URL. Returns null if the shape is wrong or the
 * city / locale combo does not match.
 */
export function parseCompanyCityPath(
  urlPath: string,
): WeeklyEmployersCompanyCityParsed | null {
  if (!urlPath) return null;
  const leading = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const withSlash = leading.endsWith('/') ? leading : `${leading}/`;

  const parts = withSlash.split('/').filter(Boolean);
  // Need at least: section + city + company + when  → 4 segments (IT)
  // or locale + 4 more (EN/DE/FR).
  if (parts.length < 4) return null;

  let idx = 0;
  let locale: WeeklyEmployersLocale = 'it';
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts[0] as WeeklyEmployersLocale;
    idx = 1;
  }

  if (parts[idx] !== WEEKLY_EMPLOYERS_SECTION[locale]) return null;

  const citySeg = parts[idx + 1];
  const companySeg = parts[idx + 2];
  const tailSeg = parts[idx + 3];
  if (!citySeg || !companySeg || !tailSeg) return null;
  if (idx + 4 !== parts.length) return null;

  if (!COMPANY_CITY_SET.has(citySeg as WeeklyEmployersCompanyCity)) return null;
  const city = citySeg as WeeklyEmployersCompanyCity;

  // Guard: companySeg must be a sluggy string, not a known archive/current slug.
  if (companySeg === WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]) return null;
  if (ARCHIVE_SLUG_RE.test(companySeg)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(companySeg)) return null;

  if (tailSeg === WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]) {
    return { locale, city, companySlug: companySeg, variant: 'current' };
  }

  const m = ARCHIVE_SLUG_RE.exec(tailSeg);
  if (!m) return null;
  if (!tailSeg.startsWith(`${WEEKLY_EMPLOYERS_ARCHIVE_PREFIX[locale]}-`)) return null;

  const weekNum = Number.parseInt(m[1], 10);
  const year = Number.parseInt(m[2], 10);
  if (!Number.isFinite(weekNum) || !Number.isFinite(year)) return null;
  return {
    locale,
    city,
    companySlug: companySeg,
    variant: 'archive',
    weekNum,
    year,
  };
}

/** Boolean form of {@link parseCompanyCityPath}. */
export function isCompanyCityPath(pathname: string): boolean {
  return parseCompanyCityPath(pathname) !== null;
}

/**
 * Enumerate every (locale × city × companySlug) current-week path given
 * a list of qualifying (city, companySlug) pairs.
 *
 * Pure helper — no file I/O; consumed by the plugin after it has resolved
 * the gate-passing company set from jobs.json.
 */
export interface CompanyCityPair {
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
}

export interface CompanyCityCurrentPath {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  variant: 'current';
  path: string;
}

export function listCompanyCityCurrentPaths(
  pairs: readonly CompanyCityPair[],
): CompanyCityCurrentPath[] {
  const out: CompanyCityCurrentPath[] = [];
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    for (const pair of pairs) {
      out.push({
        locale,
        city: pair.city,
        companySlug: pair.companySlug,
        variant: 'current',
        path: buildCompanyCityCurrentPath(locale, pair.city, pair.companySlug),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Cathedral expansion (P1.13) — CH-wide canton metadata.
//
// The legacy `WeeklyEmployersCity` type is a TI-only string-literal union
// baked into hundreds of call sites (page templates, i18n copy, slug
// builders). To support all 26 cantons WITHOUT rewriting the renderer
// layer, we layer a parallel canton-aware data model on the side. The
// existing TI city emission keeps its own pipeline; the new helpers here
// describe "the rest of Switzerland" so follow-up work (per-canton page
// renderer) can opt into them incrementally.
//
// Backward-compat contract:
//   - `WEEKLY_EMPLOYERS_CITIES` and the TI types are unchanged.
//   - Each TI city now also has a `canton: 'TI'` mapping below so any
//     consumer that needs `city → canton` lookups gets a stable answer
//     for both the legacy hubs and any new CH-wide page.
// ─────────────────────────────────────────────────────────────────────

/** ISO 2-letter Swiss canton code. */
export type SwissCantonCode =
  | 'AG' | 'AI' | 'AR' | 'BE' | 'BL' | 'BS' | 'FR' | 'GE'
  | 'GL' | 'GR' | 'JU' | 'LU' | 'NE' | 'NW' | 'OW' | 'SG'
  | 'SH' | 'SO' | 'SZ' | 'TG' | 'TI' | 'UR' | 'VD' | 'VS'
  | 'ZG' | 'ZH';

/** Every Swiss canton in BFS-canonical order. Source of truth for CH-wide iteration. */
export const SWISS_CANTON_CODES: readonly SwissCantonCode[] = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE',
  'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG',
  'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS',
  'ZG', 'ZH',
] as const;

/**
 * Static map of legacy TI city → canton. Pinned to 'TI' so any composite
 * canton/city key remains stable across legacy and CH-wide call sites.
 */
export const WEEKLY_EMPLOYERS_TI_CITY_CANTON: Record<WeeklyEmployersCity, SwissCantonCode> = {
  ticino: 'TI',
  lugano: 'TI',
  mendrisio: 'TI',
  chiasso: 'TI',
  stabio: 'TI',
  bellinzona: 'TI',
  locarno: 'TI',
};

/**
 * Schema of `data/canton-municipalities.json` (BFS AGV snapshot).
 * Mirrors the shape consumed by jobMarketSnapshotPlugin (P1.12) so both
 * plugins stay aligned on the data contract.
 */
export interface CantonMunicipalitiesFile {
  readonly cantons: Record<string, { readonly municipalities: readonly string[] }>;
}

/**
 * URL-safe slug builder for any Swiss municipality. Mirrors the shape of
 * jobMarketSnapshotPlugin's `slugifyMunicipality` so URL keys collide
 * predictably across plugins.
 *
 *   "Bern"            → "bern"
 *   "Saint-Imier"     → "saint-imier"
 *   "Arni (AG)"       → "arni-ag"
 *   "Erlinsbach (AG)" → "erlinsbach-ag"
 *
 * @param name Display name (UTF-8, may contain umlauts).
 * @returns Lowercase ASCII slug, or the empty string if the input is empty.
 */
export function slugifyMunicipality(name: string): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*\(([a-z]{2})\)/gi, '-$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Hard gate (CLAUDE.md non-negotiable #4 — no thin pages):
 * minimum number of active jobs in a (canton, ...) bucket required before
 * we emit a CH-wide weekly-employers page for that canton. Below the
 * threshold the build either skips the page entirely or emits a neutral
 * "no openings this week" stub WITHOUT calling it a real listing.
 */
export const MIN_JOBS_FOR_CANTON_PAGE = 5;

/** Boolean form of the canton-page gate; single source of truth for emitters. */
export function cantonMeetsThreshold(
  bucket: Readonly<{ activeJobsCount: number }>,
): boolean {
  return bucket.activeJobsCount >= MIN_JOBS_FOR_CANTON_PAGE;
}
