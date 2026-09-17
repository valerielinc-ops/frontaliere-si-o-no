import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import {
  inferAnyCanton,
  isCantonOnlyLabel,
  isSwissLocationText,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

function locationText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((part) => locationText(part)).filter(Boolean).join(' ');

  return [
    value.descriptor,
    value.name,
    value.location,
    value.addressLocality,
    value.city,
    value.locality,
    value.address,
    value.postalAddress,
    value.streetAddress,
    value.postalCode,
    value.postCode,
    value.addressRegion,
    value.region,
    value.country?.descriptor,
    value.country?.alpha2Code,
    value.countryCode,
  ]
    .map((part) => locationText(part))
    .filter(Boolean)
    .join(' ');
}

function normalizeCandidate(candidate) {
  const signal = locationText(candidate);
  if (!candidate || typeof candidate !== 'object') {
    return { raw: signal, signal, city: '' };
  }

  return {
    raw: locationText(candidate.descriptor)
      || locationText(candidate.name)
      || locationText(candidate.location)
      || signal,
    signal,
    city: locationText(candidate.addressLocality) || locationText(candidate.city),
  };
}

/**
 * Resolve a Workday posting to a concrete Swiss location. Workday may put a
 * country-only value before a more specific additional location, so all
 * candidates are inspected before accepting one. If no candidate supplies a
 * concrete municipality, retain the Swiss posting with FNZ's confirmed
 * Zürich office as a safe locality fallback instead of inventing a city from
 * an unresolved label such as "Remote".
 */
export function resolveFnzSwissLocation(candidates = []) {
  let countryOnlyFallback = null;

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const { raw, signal, city } = normalizeCandidate(candidate);
    if (!raw || !signal || !isSwissLocationText(signal)) continue;

    // Search the complete source signal before falling back to the ATS's first
    // segment. This covers `location: Switzerland` plus a richer
    // jobRequisitionLocation/address/postalCode object before using the safe
    // fallback below.
    const location = swissCityFromLocationField(city)
      || swissCityFromLocationField(signal)
      || city
      || firstLocationSegment(raw);
    const signalCanton = inferAnyCanton(signal);
    const locationCanton = inferAnyCanton(location);
    // A city and a richer address signal must describe the same canton. If
    // they disagree, reject the candidate rather than emit plausible-looking
    // but internally inconsistent structured data.
    const locationIsConcreteCity = Boolean(
      location && locationCanton && !isCantonOnlyLabel(location),
    );
    if (
      locationIsConcreteCity
      && (!signalCanton || signalCanton === locationCanton)
      && !/^\s*(?:switzerland|schweiz|suisse|svizzera|swiss)\s*$/i.test(location)
    ) {
      const canton = signalCanton || locationCanton;
      return { raw, location, canton };
    }

    const signalCity = swissCityFromLocationField(signal);
    const hasConflictingCitySignals = Boolean(
      signalCity
      && locationCanton
      && signalCanton
      && signalCanton !== locationCanton,
    );
    // The safe fallback is FNZ's Zürich office. Do not use it when the source
    // explicitly names another canton without a concrete municipality: that
    // would publish a locality/canton pair that contradicts the source.
    const hasIncompatibleExplicitCanton = Boolean(
      signalCanton && signalCanton !== 'ZH',
    );
    if (
      !hasConflictingCitySignals
      && !hasIncompatibleExplicitCanton
      && !countryOnlyFallback
    ) {
      countryOnlyFallback = { raw, location: 'Zürich', canton: 'ZH' };
    }
  }

  return countryOnlyFallback;
}
