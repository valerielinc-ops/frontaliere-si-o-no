import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';

const SWISS_COUNTRY_TOKENS = new Set(['ch', 'switzerland', 'svizzera', 'schweiz', 'suisse']);

function normalizeCountry(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function classifyFinconsLocation(location = '', country = '') {
  const normalizedLocation = String(location || '').trim();
  const countryToken = normalizeCountry(country);
  if (countryToken && !SWISS_COUNTRY_TOKENS.has(countryToken)) {
    return 'foreign';
  }
  if (!normalizedLocation) return 'unresolved';
  if (isLocationExplicitlyForeign(normalizedLocation)) return 'foreign';
  if (!isTargetSwissLocation(normalizedLocation, { includeBorderProximity: false })) {
    return 'unresolved';
  }
  if (!inferAnyCanton(normalizedLocation)) return 'unresolved';
  return 'swiss';
}

export function resolveFinconsLocation(detail = {}, listing = {}) {
  const detailLocation = String(detail.location || '').trim();
  const detailCountry = String(detail.country || '').trim();
  const detailHasLocationSignal = Boolean(detailLocation || detailCountry);

  // A detail page is authoritative when it explicitly identifies a foreign
  // posting. Never let a stale or generic listing row relabel that job Swiss.
  if (detailHasLocationSignal && classifyFinconsLocation(detailLocation, detailCountry) === 'foreign') {
    return null;
  }

  const candidates = [
    { value: detailLocation, country: detailCountry },
    { value: listing.location, country: '' },
  ]
    .map(({ value, country }) => ({
      location: String(value || '').trim(),
      country,
    }))
    .filter(({ location }) => location);

  for (const { location, country } of candidates) {
    if (classifyFinconsLocation(location, country) !== 'swiss') continue;
    const canton = inferAnyCanton([location, detail.region].filter(Boolean).join(', '));
    if (!canton) continue;
    return {
      location: location.split(',')[0].trim(),
      canton,
      sourceLocation: location,
    };
  }

  return null;
}
