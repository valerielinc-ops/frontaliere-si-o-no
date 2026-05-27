/**
 * Cost-of-living city landings (AE-4) — slug tables + path matchers.
 *
 * 6 cities × 4 locales = 24 static HTML pages. Cities picked from
 * `data/seo/ae4-cities.csv` (Lugano, Mendrisio, Chiasso, Bellinzona, Locarno
 * + Ticino regional rollup — volumes per Semrush organic raw).
 *
 * Routes (per spec):
 *   IT  /costo-vita-<city>-ticino/
 *   EN  /en/cost-of-living-<city>-ticino/
 *   DE  /de/lebenshaltungskosten-<city>-tessin/
 *   FR  /fr/cout-vie-<city>-tessin/
 *
 * For the "Ticino" regional rollup the double suffix is collapsed:
 *   IT  /costo-vita-ticino/
 *   EN  /en/cost-of-living-ticino/
 *   DE  /de/lebenshaltungskosten-tessin/
 *   FR  /fr/cout-vie-tessin/
 *
 * Router consumes {@link COST_OF_LIVING_LANDING_ROUTES} and
 * {@link parseCostOfLivingLandingPath} for `staticOverlay: true` matching,
 * same pattern as nursingLandingsData.ts.
 */

export const COL_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ColLocale = (typeof COL_LOCALES)[number];

export const COL_CITY_IDS = [
  'lugano',
  'mendrisio',
  'chiasso',
  'bellinzona',
  'locarno',
  'ticino',
] as const;
export type ColCityId = (typeof COL_CITY_IDS)[number];

export const COL_LOCALE_PREFIX: Record<ColLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Base slug template per locale — the city slot is filled with the city id.
 * For the `ticino` rollup the `-ticino` / `-tessin` suffix is dropped
 * (collapsed) so the URL is clean and the keyword "costo vita ticino" maps
 * 1:1 to the slug.
 */
interface SlugTemplate {
  readonly prefix: string; // e.g. "costo-vita-"
  readonly regionSuffix: string; // e.g. "-ticino"
}

const SLUG_TEMPLATES: Record<ColLocale, SlugTemplate> = {
  it: { prefix: 'costo-vita-', regionSuffix: '-ticino' },
  en: { prefix: 'cost-of-living-', regionSuffix: '-ticino' },
  de: { prefix: 'lebenshaltungskosten-', regionSuffix: '-tessin' },
  fr: { prefix: 'cout-vie-', regionSuffix: '-tessin' },
};

export function buildCostOfLivingLandingPath(locale: ColLocale, city: ColCityId): string {
  const prefix = COL_LOCALE_PREFIX[locale];
  const { prefix: slugPrefix, regionSuffix } = SLUG_TEMPLATES[locale];
  // For the regional rollup, "city + suffix" collapse is "ticino" itself
  // (IT/EN) or "tessin" (DE/FR) — we drop the redundant suffix.
  if (city === 'ticino') {
    const regionSlug = regionSuffix.replace(/^-/, ''); // "ticino" | "tessin"
    return `${prefix}/${slugPrefix}${regionSlug}/`.replace(/\/+/g, '/');
  }
  return `${prefix}/${slugPrefix}${city}${regionSuffix}/`.replace(/\/+/g, '/');
}

/** Flat list of all 24 canonical paths (4 locales × 6 cities). */
export const COST_OF_LIVING_LANDING_ROUTES: readonly string[] = COL_LOCALES.flatMap((loc) =>
  COL_CITY_IDS.map((id) => buildCostOfLivingLandingPath(loc, id)),
);

/**
 * Parse a pathname to (locale, city) or null. Handles trailing-slash
 * variants transparently.
 */
export function parseCostOfLivingLandingPath(
  pathname: string,
): { locale: ColLocale; city: ColCityId } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of COL_LOCALES) {
    for (const city of COL_CITY_IDS) {
      if (buildCostOfLivingLandingPath(locale, city) === normalized) {
        return { locale, city };
      }
    }
  }
  return null;
}

export function isCostOfLivingLandingPath(pathname: string): boolean {
  return parseCostOfLivingLandingPath(pathname) !== null;
}

/**
 * Display name per city (UI + JSON-LD Place.name). IT canonical — other
 * locales reuse the Italian city name (it's a proper noun, e.g. "Lugano"
 * in German too) except for the regional rollup.
 */
export const COL_CITY_DISPLAY: Record<ColCityId, Record<ColLocale, string>> = {
  lugano: { it: 'Lugano', en: 'Lugano', de: 'Lugano', fr: 'Lugano' },
  mendrisio: { it: 'Mendrisio', en: 'Mendrisio', de: 'Mendrisio', fr: 'Mendrisio' },
  chiasso: { it: 'Chiasso', en: 'Chiasso', de: 'Chiasso', fr: 'Chiasso' },
  bellinzona: { it: 'Bellinzona', en: 'Bellinzona', de: 'Bellinzona', fr: 'Bellinzona' },
  locarno: { it: 'Locarno', en: 'Locarno', de: 'Locarno', fr: 'Locarno' },
  ticino: {
    it: 'Canton Ticino',
    en: 'Canton Ticino',
    de: 'Kanton Tessin',
    fr: 'Canton du Tessin',
  },
};

/** Commune postal codes + coordinates for Place JSON-LD. */
export const COL_CITY_GEO: Record<
  ColCityId,
  { postalCode: string | null; addressLocality: string | null; lat: number | null; lon: number | null }
> = {
  lugano: { postalCode: '6900', addressLocality: 'Lugano', lat: 46.0037, lon: 8.9511 },
  mendrisio: { postalCode: '6850', addressLocality: 'Mendrisio', lat: 45.8697, lon: 8.9797 },
  chiasso: { postalCode: '6830', addressLocality: 'Chiasso', lat: 45.8366, lon: 9.0319 },
  bellinzona: { postalCode: '6500', addressLocality: 'Bellinzona', lat: 46.1945, lon: 9.0256 },
  locarno: { postalCode: '6600', addressLocality: 'Locarno', lat: 46.1712, lon: 8.7959 },
  ticino: { postalCode: null, addressLocality: null, lat: 46.17, lon: 8.81 },
};
