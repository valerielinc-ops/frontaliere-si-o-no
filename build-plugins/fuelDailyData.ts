/**
 * Fuel-daily page data: slug maps, path builders, route enumeration.
 *
 * F6 — GSC evidence shows 1000+ monthly impressions for "dieselpreis schweiz
 * aktuell 2026", "diesel price switzerland 2026" and similar queries at
 * avg position 7.5 but 0 clicks. The existing editorial articles don't
 * satisfy the "oggi / heute / today / aujourd'hui" intent — users want the
 * current-day price in the hero. This module wires the URL structure for
 * static-HTML "today" pages (regional + per-zone) in all 4 locales, plus
 * dated month-archive URLs for continuity.
 */

export type FuelDailyLocale = 'it' | 'en' | 'de' | 'fr';
export type FuelType = 'diesel' | 'benzina';
export type FuelZone = 'chiasso' | 'mendrisio' | 'lugano' | 'bellinzona' | 'locarno';

export const FUEL_DAILY_LOCALES: readonly FuelDailyLocale[] = ['it', 'en', 'de', 'fr'] as const;
export const FUEL_TYPES: readonly FuelType[] = ['diesel', 'benzina'] as const;
export const FUEL_ZONES: readonly FuelZone[] = [
  'chiasso',
  'mendrisio',
  'lugano',
  'bellinzona',
  'locarno',
] as const;

/** Zone display names (proper nouns — same across all locales). */
export const FUEL_ZONE_DISPLAY: Record<FuelZone, string> = {
  chiasso: 'Chiasso',
  mendrisio: 'Mendrisio',
  lugano: 'Lugano',
  bellinzona: 'Bellinzona',
  locarno: 'Locarno',
};

/** Section slug per locale × fuel type (top-level URL segment). */
export const FUEL_SECTION_SLUG: Record<FuelDailyLocale, Record<FuelType, string>> = {
  it: {
    diesel: 'prezzi-diesel',
    benzina: 'prezzi-benzina',
  },
  en: {
    diesel: 'diesel-price-switzerland',
    benzina: 'gasoline-price-switzerland',
  },
  de: {
    diesel: 'dieselpreis-schweiz',
    benzina: 'benzinpreis-schweiz',
  },
  fr: {
    diesel: 'prix-gasoil-suisse',
    benzina: 'prix-essence-suisse',
  },
};

/** "Today" keyword per locale. */
export const FUEL_TODAY_SLUG: Record<FuelDailyLocale, string> = {
  it: 'oggi',
  en: 'today',
  de: 'heute',
  fr: 'aujourd-hui',
};

/** Locale prefix for non-IT URLs. */
export const FUEL_LOCALE_PREFIX: Record<FuelDailyLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Localized display labels for fuel type (used in copy, H1). */
export const FUEL_TYPE_LABEL: Record<FuelDailyLocale, Record<FuelType, string>> = {
  it: { diesel: 'Diesel', benzina: 'Benzina' },
  en: { diesel: 'Diesel', benzina: 'Gasoline' },
  de: { diesel: 'Diesel', benzina: 'Benzin' },
  fr: { diesel: 'Gasoil', benzina: 'Essence' },
};

export interface FuelDailyPath {
  locale: FuelDailyLocale;
  fuel: FuelType;
  zone?: FuelZone;
  /** Canonical URL path with trailing slash, e.g. /prezzi-diesel/oggi/ or /prezzi-diesel/chiasso/oggi/. */
  path: string;
}

/**
 * Build the canonical path for a "today" fuel page.
 * - No zone → regional page (all of Ticino)
 * - With zone → per-zone page for the given city
 */
function joinPath(parts: string[]): string {
  // Filter out empty segments (e.g. locale prefix ""), then join and normalise
  // to a canonical "/a/b/c/" form with exactly one leading slash and a single
  // trailing slash.
  const nonEmpty = parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

export function buildFuelTodayPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  zone?: FuelZone,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  const today = FUEL_TODAY_SLUG[locale];
  return zone ? joinPath([prefix, section, zone, today]) : joinPath([prefix, section, today]);
}

/**
 * Build the canonical path for a month-archive fuel page.
 * monthKey: "YYYY-MM".
 */
export function buildFuelArchivePath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  zone: FuelZone,
  monthKey: string,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  return joinPath([prefix, section, zone, monthKey]);
}

/**
 * Enumerate every "today" fuel page path (regional + per-zone) across all
 * locales and fuel types.
 *
 * Count: 4 locales × 2 fuels × (1 regional + 5 zones) = 48 paths.
 */
export function listFuelTodayPaths(): FuelDailyPath[] {
  const out: FuelDailyPath[] = [];
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      // Regional (no zone)
      out.push({ locale, fuel, path: buildFuelTodayPath(locale, fuel) });
      for (const zone of FUEL_ZONES) {
        out.push({ locale, fuel, zone, path: buildFuelTodayPath(locale, fuel, zone) });
      }
    }
  }
  return out;
}

/**
 * Router route table: all "today" fuel paths. Imported by services/router.ts
 * so unknown /prezzi-diesel/... URLs resolve to a known route (stats/fuel-prices
 * tab) instead of falling through to 404.
 */
export const FUEL_DAILY_ROUTES: readonly string[] = listFuelTodayPaths().map((p) => p.path);

/** Precomputed lookup set for fast O(1) router matching. */
const FUEL_DAILY_ROUTE_SET: ReadonlySet<string> = new Set(FUEL_DAILY_ROUTES);

/**
 * Return true when `pathname` (with or without trailing slash) matches one of
 * the canonical fuel-daily URLs (in any locale / fuel / zone).
 *
 * Also matches month-archive URLs like /prezzi-diesel/chiasso/2026-04/ when the
 * final segment is a YYYY-MM pattern — archives are emitted on demand so we
 * allow them by shape without enumerating every month.
 */
export function isFuelDailyPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  if (FUEL_DAILY_ROUTE_SET.has(normalised)) return true;
  return isFuelMonthArchivePath(normalised);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Return true when the path ends in /YYYY-MM/ under a fuel-daily section. */
export function isFuelMonthArchivePath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  const last = parts[parts.length - 1];
  if (!MONTH_PATTERN.test(last)) return false;
  // Reconstruct the "section" segments (skip optional locale prefix and optional zone)
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  const section = parts[idx];
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      if (FUEL_SECTION_SLUG[locale][fuel] === section) {
        // Expected shape: [prefix?] section [zone] YYYY-MM
        const zoneIdx = idx + 1;
        const monthIdx = idx + 2;
        if (monthIdx !== parts.length - 1) return false;
        return (FUEL_ZONES as readonly string[]).includes(parts[zoneIdx]);
      }
    }
  }
  return false;
}
