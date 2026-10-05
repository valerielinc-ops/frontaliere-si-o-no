/**
 * Shared fuel route slugs.
 *
 * The build emitters, SPA route guard and the dependency-free Bing inventory
 * all need the same localized route vocabulary. Keeping it here prevents an
 * audit classifier from silently drifting away from the URLs the build emits.
 */

export const FUEL_SECTION_SLUG = Object.freeze({
  it: Object.freeze({ diesel: 'prezzi-diesel', benzina: 'prezzi-benzina' }),
  en: Object.freeze({ diesel: 'diesel-price-switzerland', benzina: 'gasoline-price-switzerland' }),
  de: Object.freeze({ diesel: 'dieselpreis-schweiz', benzina: 'benzinpreis-schweiz' }),
  fr: Object.freeze({ diesel: 'prix-gasoil-suisse', benzina: 'prix-essence-suisse' }),
});

export const FUEL_INDEX_SLUG = Object.freeze({
  swissStations: Object.freeze({
    it: 'stazioni-svizzere',
    en: 'swiss-stations',
    de: 'schweizer-tankstellen',
    fr: 'stations-suisses',
  }),
  italianStations: Object.freeze({
    it: 'stazioni-italia',
    en: 'italian-stations',
    de: 'italienische-tankstellen',
    fr: 'stations-italiennes',
  }),
  italianCities: Object.freeze({
    it: 'citta-italiane',
    en: 'italian-cities',
    de: 'italienische-staedte',
    fr: 'villes-italiennes',
  }),
});

export const FUEL_INDEX_TERMINAL_SLUGS = new Set(
  Object.values(FUEL_INDEX_SLUG).flatMap((byLocale) => Object.values(byLocale)),
);
