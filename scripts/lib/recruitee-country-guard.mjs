/**
 * Source-backed country gate for Recruitee locations.
 *
 * Recruitee exposes the location country separately from the employer's HQ.
 * Dedicated Swiss feeds must use that location evidence: an employer being
 * registered in Switzerland is not evidence that a remote worldwide offer is
 * a Swiss posting.
 */
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { isSwissLocationText } from './target-swiss-locations.mjs';

const SWISS_COUNTRY_CODES = new Set(['ch', 'che']);
const SWISS_COUNTRY_NAMES = new Set([
  'schweiz',
  'switzerland',
  'suisse',
  'svizzera',
]);

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function locationText(location) {
  return [
    location?.name,
    location?.city,
    location?.state,
    location?.country,
    location?.country_code,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Return true only for a concrete Recruitee location with Swiss evidence.
 * Missing/ambiguous country data is deliberately rejected.
 */
export function isSwissRecruiteeLocation(location = {}) {
  const city = String(location?.city || '').trim();
  if (!city) return false;

  const text = locationText(location);
  if (!text || isLocationExplicitlyForeign(text)) return false;

  const countryCode = normalize(location?.country_code || location?.countryCode);
  if (countryCode) return SWISS_COUNTRY_CODES.has(countryCode);

  const country = normalize(location?.country);
  if (country) return SWISS_COUNTRY_NAMES.has(country);

  // A country-less source row is accepted only when its own location text is
  // a known Swiss locality/canton; an unresolved remote row stays quarantined.
  return isSwissLocationText(text);
}

/**
 * Select the first Swiss location from a Recruitee offer.
 * Returning the source object preserves its city/state/postal evidence for the
 * caller; foreign-only and unresolved offers return null.
 */
export function findSwissRecruiteeLocation(locations) {
  return (Array.isArray(locations) ? locations : []).find(isSwissRecruiteeLocation) || null;
}
