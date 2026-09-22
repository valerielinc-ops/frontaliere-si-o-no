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
