import {
  FUEL_ITALY_SLUG,
  FUEL_SECTION_SLUG,
  FUEL_STATIONS_SLUG,
  FUEL_TODAY_SLUG,
} from '../../build-plugins/shared/fuelRouteSlugs.mjs';

const LEGACY_FUEL_SECTIONS = new Map([
  ['prezzi-benzina-svizzera', { locale: 'it', fuel: 'benzina' }],
  ['prezzi-carburante-svizzera', { locale: 'it', fuel: 'benzina' }],
  ['fuel-prices-switzerland', { locale: 'en', fuel: 'benzina' }],
  ['benzinpreise-schweiz', { locale: 'de', fuel: 'benzina' }],
  ['prix-diesel-suisse', { locale: 'fr', fuel: 'diesel' }],
]);

const FUEL_STATION_SEGMENT_ALIASES = new Set(Object.values(FUEL_STATIONS_SLUG));

/**
 * Resolve a retired per-station URL to the current localized daily page for its city.
 *
 * A station-shaped legacy URL is not enough evidence that a similarly named
 * active station is the same location. Falling back to the city's daily page
 * keeps the result useful without transferring identity or prices between stations.
 */
export function resolveFuelStation(orphanPath) {
  if (typeof orphanPath !== 'string' || !orphanPath.startsWith('/')) return null;
  const parts = orphanPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const hasLocale = /^(?:en|de|fr)$/i.test(parts[0] ?? '');
  let locale = (hasLocale ? parts.shift() : 'it').toLowerCase();
  if (!FUEL_SECTION_SLUG[locale]) return null;

  const section = parts.shift()?.toLowerCase();
  if (!section || ![3, 4].includes(parts.length)) return null;
  let fuel = Object.entries(FUEL_SECTION_SLUG[locale] ?? {})
    .find(([, sectionSlug]) => sectionSlug === section)?.[0];

  const legacy = LEGACY_FUEL_SECTIONS.get(section);
  if (legacy) {
    if (hasLocale && locale !== legacy.locale) return null;
    locale = legacy.locale;
    fuel = legacy.fuel;
  }
  if (!fuel) return null;

  const italian = parts.length === 4;
  const italySegment = italian ? parts[0]?.toLowerCase() : null;
  const city = parts[italian ? 1 : 0]?.toLowerCase();
  const stationSegment = parts[italian ? 2 : 1]?.toLowerCase();
  const stationSlug = parts[italian ? 3 : 2];
  if (!city || !stationSegment || !stationSlug) return null;
  if (italian && italySegment !== FUEL_ITALY_SLUG[locale]) return null;
  const validStationSegment = italian
    ? stationSegment === FUEL_STATIONS_SLUG[locale]
    : FUEL_STATION_SEGMENT_ALIASES.has(stationSegment);
  if (!validStationSegment) return null;

  const prefix = locale === 'it' ? '' : `/${locale}`;
  const canonicalSection = FUEL_SECTION_SLUG[locale][fuel];
  const cityPath = italian ? `${FUEL_ITALY_SLUG[locale]}/${city}` : city;
  return {
    kind: 'matched',
    locale,
    canonicalPath: `${prefix}/${canonicalSection}/${cityPath}/${FUEL_TODAY_SLUG[locale]}/`,
  };
}
