/**
 * Shared Switzerland country-field recognition for crawler CH guards.
 *
 * Several dedicated parsers gate listings on a "this row is in Switzerland"
 * check before publishing (Decathlon #1720, Debiopharm, Guess). Each had its own
 * brittle test that dropped a VALID CH row when the upstream country field
 * arrived in an unexpected shape (#2419):
 *   - strict full-string / equality match missed "Switzerland (CH)", "CH - Suisse",
 *     ISO-3166 alpha-3 "CHE", and the numeric code 756;
 *   - a naive `String(obj)` of an `address.country` OBJECT yields "[object Object]",
 *     which never matches → the row is silently skipped.
 *
 * This module centralises the recognition so the matcher can't drift across the
 * sibling parsers (AGENTS.md #6: duplicated regex/constant → one shared module).
 */

// CONTAINS test (not anchored): the field can arrive as "Switzerland (CH)",
// "CH - Suisse", or numeric ISO-3166 756. Word boundaries keep non-CH tokens out
// — "France"/"DE"/"Liechtenstein"/"China"/"Chile"/"Czech" contain no bounded CH
// marker, so they're still rejected.
export const CH_COUNTRY_RX = /\b(ch|che|756|switzerland|suisse|schweiz|svizzera)\b/i;

/**
 * Coerce a country-ish field to a comparable trimmed string.
 *
 * The field may be a plain string ("CH"), a numeric ISO-3166 code (756), or an
 * object (`address.country` = { code, name, ... }). A naive String(obj) yields
 * "[object Object]"; pull the first meaningful scalar out instead. Returns '' for
 * null/undefined/empty so callers can distinguish "absent" from "present non-CH".
 */
export function coerceCountryField(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const scalar =
      raw.code ?? raw.iso ?? raw.iso2 ?? raw.alpha2 ?? raw.alpha3 ??
      raw.id ?? raw.value ?? raw.name ?? raw.label ?? '';
    return String(scalar).trim();
  }
  return String(raw).trim();
}

/**
 * True when the (coerced) country field denotes Switzerland. Empty/absent → false
 * (callers decide whether absence means skip or fall back to domain trust).
 */
export function isChCountry(raw) {
  const token = coerceCountryField(raw);
  return token !== '' && CH_COUNTRY_RX.test(token);
}
