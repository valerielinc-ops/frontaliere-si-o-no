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

// ── D-2A: Per-station + Italian city pages ─────────────────────────
//
// The F6 pages originally covered just the regional + 5 Ticino zones. GSC
// shows strong long-tail demand for brand+street queries ("eni stabio prezzo
// diesel", "benzina como oggi") that the zone hubs cannot fully satisfy. We
// now emit one indexable page per Swiss (Ticino) station and a per-city hub
// for the top Italian border towns.
//
// URL patterns (hub-and-spoke, approved):
//   Swiss per-station:   /prezzi-diesel/{zone}/stazioni/{station-slug}/
//   IT per-city hub:     /prezzi-benzina/italia/{city-slug}/oggi/
//   IT per-station:      /prezzi-benzina/italia/{city-slug}/stazioni/{station-slug}/

/** Stations slug segment per locale. */
export const FUEL_STATIONS_SLUG: Record<FuelDailyLocale, string> = {
  it: 'stazioni',
  en: 'stations',
  de: 'tankstellen',
  fr: 'stations',
};

/** "Italy" segment per locale. */
export const FUEL_ITALY_SLUG: Record<FuelDailyLocale, string> = {
  it: 'italia',
  en: 'italy',
  de: 'italien',
  fr: 'italie',
};

/**
 * Normalise a free-form string to a kebab-case URL slug.
 * Strips accents, punctuation, extra whitespace. Safe for station names,
 * addresses, brand names, city names.
 */
export function slugify(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80); // URL length sanity cap
}

/**
 * Derive a stable per-station slug from brand + address.
 *
 * Pattern: `{brand}-{street}`. We strip house numbers and postal codes to
 * keep the slug readable. Example: `eni-via-compolongo`.
 *
 * When brand is missing or is the sentinel "UNDEFINED", we fall back to the
 * station name (first word) combined with the street.
 */
export function buildStationSlug(opts: {
  brand?: string | null;
  name?: string | null;
  address?: string | null;
}): string {
  const { brand, name, address } = opts;
  // Extract "street part": everything before the postal code + city portion.
  // Addresses look like "Via Foo 12, 6830 Chiasso" or "Foo Road, Bar".
  // We keep the segment before the first comma, then strip house numbers.
  let street = '';
  if (address) {
    const firstPart = address.split(',')[0] ?? '';
    street = firstPart.replace(/\s+\d+[A-Za-z]?$/g, '').trim();
  }

  const brandClean = brand && brand.toUpperCase() !== 'UNDEFINED' ? brand : '';
  const firstNameWord = name ? name.split(/\s+/)[0] ?? '' : '';
  const prefix = brandClean || firstNameWord || 'stazione';

  const slug = slugify(`${prefix}-${street}`);
  return slug || slugify(name ?? '') || 'stazione';
}

/** Build the canonical path for a Swiss per-station page. */
export function buildFuelStationPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  zone: FuelZone,
  stationSlug: string,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  const stationsSeg = FUEL_STATIONS_SLUG[locale];
  return joinPath([prefix, section, zone, stationsSeg, stationSlug]);
}

/** Build the canonical path for an Italian city hub page. */
export function buildFuelItalianCityPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  citySlug: string,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  const italy = FUEL_ITALY_SLUG[locale];
  const today = FUEL_TODAY_SLUG[locale];
  return joinPath([prefix, section, italy, citySlug, today]);
}

/** Build the canonical path for an Italian per-station page. */
export function buildFuelItalianStationPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  citySlug: string,
  stationSlug: string,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  const italy = FUEL_ITALY_SLUG[locale];
  const stationsSeg = FUEL_STATIONS_SLUG[locale];
  return joinPath([prefix, section, italy, citySlug, stationsSeg, stationSlug]);
}

/**
 * Map a raw city string (from a station address) to a Ticino zone.
 * Returns null for cities outside the 5 canonical zones — those stations are
 * skipped from per-station page generation (we emit only Ticino stations).
 *
 * The mapping is case-insensitive and matches the city *exactly* (after
 * trimming). We do NOT do fuzzy partial matching to avoid false positives
 * (e.g. "Gondo" in Valais must not match "Gondo" anywhere).
 */
export const FUEL_CITY_TO_ZONE: Record<string, FuelZone> = {
  // Chiasso zone (Mendrisiotto south)
  chiasso: 'chiasso',
  balerna: 'chiasso',
  coldrerio: 'chiasso',
  vacallo: 'chiasso',
  novazzano: 'chiasso',
  'morbio inferiore': 'chiasso',
  // Mendrisio
  mendrisio: 'mendrisio',
  stabio: 'mendrisio',
  'san pietro di stabio': 'mendrisio',
  serfontana: 'mendrisio',
  // Lugano (Luganese)
  lugano: 'lugano',
  caslano: 'lugano',
  magliaso: 'lugano',
  bioggio: 'lugano',
  purasca: 'lugano',
  monteggio: 'lugano',
  'molinazzo di monteggio': 'lugano',
  molinazzo: 'lugano',
  gandria: 'lugano',
  cadempino: 'lugano',
  manno: 'lugano',
  tesserete: 'lugano',
  lugaggia: 'lugano',
  muzzano: 'lugano',
  morcote: 'lugano',
  // Bellinzona (incl. Moesano)
  bellinzona: 'bellinzona',
  giubiasco: 'bellinzona',
  arbedo: 'bellinzona',
  roveredo: 'bellinzona',
  grono: 'bellinzona',
  'san vittore': 'bellinzona',
  cama: 'bellinzona',
  // Locarno (incl. Vallemaggia, Gambarogno)
  locarno: 'locarno',
  brissago: 'locarno',
  'vira (gambarogno)': 'locarno',
  gordevio: 'locarno',
  giumaglio: 'locarno',
};

/**
 * Extract the city name from the tail of a station address string.
 * Heuristic: "...Via Foo 12, 6830 Chiasso" → "Chiasso".
 * Returns the lowercase city or null when the pattern doesn't match.
 */
export function extractCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',');
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1].trim();
  // Strip leading postal code (e.g. "6830 Chiasso" → "Chiasso")
  const withoutCap = last.replace(/^\d{4,5}\s+/, '').trim();
  return withoutCap.toLowerCase() || null;
}

/** Resolve the Ticino zone for a raw station address. */
export function zoneForAddress(address: string | null | undefined): FuelZone | null {
  const city = extractCityFromAddress(address);
  if (!city) return null;
  return FUEL_CITY_TO_ZONE[city] ?? null;
}

/**
 * Curated list of Italian border cities we emit hubs for. Chosen because:
 *  1. They sit within 20-30 km of Ticino
 *  2. GSC long-tail queries frequently mention them ("benzina como", etc.)
 *  3. They cover the three main crossing corridors (Chiasso, Ponte Tresa,
 *     Luino/Gaggiolo)
 *
 * Display name is the proper-case city, slug is URL-safe.
 */
export interface ItalianCityEntry {
  readonly slug: string;
  readonly display: string;
  /** Lowercase municipality key as it appears in data/fuel-prices.json. */
  readonly matchKey: string;
  /** Province code (CO/VA/SO/VB). */
  readonly province: string;
  /** Nearest Ticino fuel zone (for cross-linking). */
  readonly nearestZone: FuelZone;
}

export const FUEL_ITALIAN_CITIES: readonly ItalianCityEntry[] = [
  { slug: 'como', display: 'Como', matchKey: 'como', province: 'CO', nearestZone: 'chiasso' },
  { slug: 'varese', display: 'Varese', matchKey: 'varese', province: 'VA', nearestZone: 'mendrisio' },
  { slug: 'luino', display: 'Luino', matchKey: 'luino', province: 'VA', nearestZone: 'locarno' },
  { slug: 'lavena-ponte-tresa', display: 'Lavena Ponte Tresa', matchKey: 'lavena ponte tresa', province: 'VA', nearestZone: 'lugano' },
  { slug: 'gallarate', display: 'Gallarate', matchKey: 'gallarate', province: 'VA', nearestZone: 'mendrisio' },
  { slug: 'cantu', display: 'Cantù', matchKey: 'cantù', province: 'CO', nearestZone: 'chiasso' },
  { slug: 'saronno', display: 'Saronno', matchKey: 'saronno', province: 'VA', nearestZone: 'mendrisio' },
  { slug: 'menaggio', display: 'Menaggio', matchKey: 'menaggio', province: 'CO', nearestZone: 'lugano' },
  { slug: 'porto-ceresio', display: 'Porto Ceresio', matchKey: 'porto ceresio', province: 'VA', nearestZone: 'lugano' },
  { slug: 'lecco', display: 'Lecco', matchKey: 'lecco', province: 'LC', nearestZone: 'bellinzona' },
  { slug: 'sondrio', display: 'Sondrio', matchKey: 'sondrio', province: 'SO', nearestZone: 'bellinzona' },
  { slug: 'tirano', display: 'Tirano', matchKey: 'tirano', province: 'SO', nearestZone: 'bellinzona' },
  { slug: 'chiavenna', display: 'Chiavenna', matchKey: 'chiavenna', province: 'SO', nearestZone: 'bellinzona' },
  { slug: 'morbegno', display: 'Morbegno', matchKey: 'morbegno', province: 'SO', nearestZone: 'bellinzona' },
  { slug: 'cernobbio', display: 'Cernobbio', matchKey: 'cernobbio', province: 'CO', nearestZone: 'chiasso' },
] as const;

/** Lookup an Italian-city entry by its slug. */
export function findItalianCityBySlug(slug: string): ItalianCityEntry | null {
  return FUEL_ITALIAN_CITIES.find((c) => c.slug === slug) ?? null;
}

/**
 * Recognise a Swiss per-station canonical path:
 * `/[locale?]/{section}/{zone}/{stations-slug}/{station-slug}/`
 */
export function isFuelStationPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 4) return false;
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  // Must be [section, zone, stations-seg, station-slug]
  if (parts.length < idx + 4) return false;
  const section = parts[idx];
  const zone = parts[idx + 1];
  const stationsSeg = parts[idx + 2];
  // Section must match a known fuel section for any locale/fuel
  let sectionMatch = false;
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      if (FUEL_SECTION_SLUG[locale][fuel] === section) sectionMatch = true;
    }
  }
  if (!sectionMatch) return false;
  if (!(FUEL_ZONES as readonly string[]).includes(zone)) return false;
  let stationsSegMatch = false;
  for (const locale of FUEL_DAILY_LOCALES) {
    if (FUEL_STATIONS_SLUG[locale] === stationsSeg) stationsSegMatch = true;
  }
  return stationsSegMatch;
}

/**
 * Recognise an Italian city hub path:
 * `/[locale?]/{section}/{italy-slug}/{city-slug}/{today}/`
 */
export function isFuelItalianCityPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 4) return false;
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  if (parts.length < idx + 4) return false;
  const section = parts[idx];
  const italySeg = parts[idx + 1];
  const lastSeg = parts[parts.length - 1];
  let sectionMatch = false;
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      if (FUEL_SECTION_SLUG[locale][fuel] === section) sectionMatch = true;
    }
  }
  if (!sectionMatch) return false;
  let italyMatch = false;
  for (const locale of FUEL_DAILY_LOCALES) {
    if (FUEL_ITALY_SLUG[locale] === italySeg) italyMatch = true;
  }
  if (!italyMatch) return false;
  // Accept both the "today" hub (ends with today slug) and per-station (4+ segs)
  for (const locale of FUEL_DAILY_LOCALES) {
    if (FUEL_TODAY_SLUG[locale] === lastSeg) return true;
    if (FUEL_STATIONS_SLUG[locale] === parts[idx + 2]) {
      // shape: [section, italy, stations, slug] — invalid (need city before stations)
      return false;
    }
  }
  // Per-station IT: last is station-slug, parts[idx+3] is stations-seg
  if (parts.length >= idx + 5) {
    const stationsSeg = parts[idx + 3];
    for (const locale of FUEL_DAILY_LOCALES) {
      if (FUEL_STATIONS_SLUG[locale] === stationsSeg) return true;
    }
  }
  return false;
}

/**
 * Compute the CHF/litre price delta vs yesterday.
 *
 * Returns `null` (never `0`) when either value is absent:
 *  - `todayAvg === null`  → today's zone price could not be computed
 *  - `yesterdayAvg === null` → yesterday snapshot is missing entirely, or the
 *    zone/fuel entry is absent from that snapshot
 *
 * Callers that receive `null` must render an em-dash ("—") rather than
 * formatting the value as a number.  A legitimate zero delta (today == yesterday)
 * is a distinct case and IS returned as `0`.
 */
export function computeDeltaVsYesterday(
  todayAvg: number | null,
  yesterdayAvg: number | null,
): number | null {
  if (todayAvg === null || yesterdayAvg === null) return null;
  return Number((todayAvg - yesterdayAvg).toFixed(3));
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
 * Terminal slugs of the fuel-station / fuel-cities browseable INDEX pages
 * (defined in build-plugins/fuelStationIndexPages.ts → FUEL_INDEX_SLUG).
 *
 * Mirrored here as a flat set so isFuelDailyPath() — imported by the SPA
 * router — can recognise these URLs without pulling in the index plugin
 * (which depends on Node-only build helpers). Keep in sync with
 * FUEL_INDEX_SLUG; tests/seo/fuel-station-index-router.test.ts asserts
 * the two stay aligned.
 */
const FUEL_INDEX_TERMINAL_SLUGS: ReadonlySet<string> = new Set([
  'stazioni-svizzere', 'swiss-stations', 'schweizer-tankstellen', 'stations-suisses',
  'stazioni-italia', 'italian-stations', 'italienische-tankstellen', 'stations-italiennes',
  'citta-italiane', 'italian-cities', 'italienische-staedte', 'villes-italiennes',
]);

/**
 * Recognise a fuel-station / fuel-cities index path:
 * `/[locale?]/{section}/{terminal-slug}/`
 *
 * Examples:
 *   /prezzi-benzina/stazioni-italia/
 *   /en/gasoline-price-switzerland/swiss-stations/
 */
export function isFuelStationIndexPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  // Expected shape: [prefix?] section terminal-slug — exactly idx+2 parts.
  if (parts.length !== idx + 2) return false;
  const section = parts[idx];
  const terminal = parts[idx + 1];
  let sectionMatch = false;
  for (const locale of FUEL_DAILY_LOCALES) {
    for (const fuel of FUEL_TYPES) {
      if (FUEL_SECTION_SLUG[locale][fuel] === section) sectionMatch = true;
    }
  }
  if (!sectionMatch) return false;
  return FUEL_INDEX_TERMINAL_SLUGS.has(terminal);
}

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
  if (isFuelMonthArchivePath(normalised)) return true;
  if (isFuelStationPath(normalised)) return true;
  if (isFuelItalianCityPath(normalised)) return true;
  if (isFuelStationIndexPath(normalised)) return true;
  return false;
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
