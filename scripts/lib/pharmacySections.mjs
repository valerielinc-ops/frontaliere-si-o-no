/**
 * Canonical route bases for the pharmacy data vertical.
 *
 * Pharmacy pages are structured directory and duty records, not editorial
 * guide pages. Keep this matcher runtime-neutral so the Node audit can share
 * the same route boundary without importing the TypeScript route grammar.
 * The list mirrors LOCALE_BASES and PHARMACY_DUTY_HUB_PATH in
 * services/pharmacies/paths.ts and services/pharmacies/types.ts.
 */

export const PHARMACY_SECTION_BASES = Object.freeze([
  'farmacie',
  'farmacie-di-turno',
  'en/pharmacies',
  'en/on-duty-pharmacies',
  'de/apotheken',
  'de/notdienst-apotheken',
  'fr/pharmacies',
  'fr/pharmacies-de-garde',
]);

// Castagnola is a Lugano quarter (municipal source), and OFCT explicitly
// includes its pharmacy in the same Luganese duty region as Lugano:
// https://www.lugano.ch/la-mia-citta/identita-e-storia/quartieri/cassarate-castagnola.html
// https://www.ofct.ch/luganese/
// Only the regional-duty intent is equivalent. Do not infer directory,
// individual-pharmacy, weekly, or other-quarter redirects from this map.
export const PHARMACY_DUTY_CITY_REDIRECTS = Object.freeze({
  '/farmacie/ticino/castagnola/di-turno/': '/farmacie/ticino/lugano/di-turno/',
  '/en/pharmacies/ticino/castagnola/on-duty/': '/en/pharmacies/ticino/lugano/on-duty/',
  '/de/apotheken/ticino/castagnola/notdienst/': '/de/apotheken/ticino/lugano/notdienst/',
  '/fr/pharmacies/ticino/castagnola/de-garde/': '/fr/pharmacies/ticino/lugano/de-garde/',
});

/** @param {string} pathname @returns {string | null} */
export function resolvePharmacyDutyCityAlias(pathname) {
  return Object.prototype.hasOwnProperty.call(PHARMACY_DUTY_CITY_REDIRECTS, pathname)
    ? PHARMACY_DUTY_CITY_REDIRECTS[pathname] : null;
}

const PHARMACY_SECTION_SOURCE = PHARMACY_SECTION_BASES
  .map((base) => base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** Matches a pharmacy vertical route in a dist-relative or URL path. */
export const PHARMACY_SECTION_RX = new RegExp(
  `^/?(?:${PHARMACY_SECTION_SOURCE})(?:/|$)`,
);

/**
 * @param {string} pharmacySectionPath dist-relative path or URL path
 * @returns {boolean} whether the path belongs to the pharmacy vertical
 */
export function isPharmacySectionPath(pharmacySectionPath) {
  return PHARMACY_SECTION_RX.test(String(pharmacySectionPath));
}
