import { FUEL_SECTION_SLUG, FUEL_TODAY_SLUG } from '../../build-plugins/shared/fuelRouteSlugs.mjs';

const LEGACY_FUEL_SECTIONS = new Map([
  ['prezzi-benzina-svizzera', { locale: 'it', fuel: 'benzina' }],
  ['prezzi-carburante-svizzera', { locale: 'it', fuel: 'benzina' }],
  ['fuel-prices-switzerland', { locale: 'en', fuel: 'benzina' }],
  ['benzinpreise-schweiz', { locale: 'de', fuel: 'benzina' }],
  ['prix-diesel-suisse', { locale: 'fr', fuel: 'diesel' }],
]);

/**
 * Resolve a retired per-station URL to the current localized daily page for its city.
 *
 * A station-shaped legacy URL is not enough evidence that a similarly named
 * active station is the same location. Falling back to the city's daily page
 * keeps the result useful without transferring identity or prices between stations.
 */
export function resolveFuelStation(orphanPath) {
  const match = orphanPath.match(/^\/(?:((?:en|de|fr))\/)?([^/]+)\/([^/]+)\/(?:stazioni|stations|tankstellen)\/[^/]+\/?$/i);
  if (!match) return null;

  let locale = (match[1] || 'it').toLowerCase();
  const section = match[2].toLowerCase();
  const city = match[3].toLowerCase();
  let fuel = Object.entries(FUEL_SECTION_SLUG[locale] ?? {})
    .find(([, sectionSlug]) => sectionSlug === section)?.[0];

  const legacy = LEGACY_FUEL_SECTIONS.get(section);
  if (legacy) {
    if (match[1] && locale !== legacy.locale) return null;
    locale = legacy.locale;
    fuel = legacy.fuel;
  }
  if (!fuel) return null;

  const prefix = locale === 'it' ? '' : `/${locale}`;
  const canonicalSection = FUEL_SECTION_SLUG[locale][fuel];
  return {
    kind: 'matched',
    locale,
    canonicalPath: `${prefix}/${canonicalSection}/${city}/${FUEL_TODAY_SLUG[locale]}/`,
  };
}
