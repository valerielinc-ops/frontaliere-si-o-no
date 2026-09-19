import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import {
  inferAnyCanton,
  isCantonOnlyLabel,
  isSwissLocationText,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

// Country-only Workday locations stay nationally scoped while structured data
// receives one coherent safe address.
const FNZ_NATIONAL_ADDRESS_FALLBACK = Object.freeze({
  addressLocality: 'Bern',
  addressRegion: 'BE',
  postalCode: '3011',
  streetAddress: 'Bundesplatz 3',
});

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
    return { raw: signal, signal, city: '', hasStructuredAddress: false };
  }

  const city = locationText(candidate.addressLocality) || locationText(candidate.city);
  const hasStructuredAddress = Boolean(
    city
    && [
      candidate.postalCode,
      candidate.postCode,
      candidate.streetAddress,
      candidate.address,
      candidate.postalAddress,
    ].some((value) => locationText(value)),
  );

  return {
    raw: locationText(candidate.descriptor)
      || locationText(candidate.name)
      || locationText(candidate.location)
      || signal,
    signal,
    city,
    hasStructuredAddress,
  };
}

function isCountryOnlySwissSignal(signal) {
  const value = String(signal || '');
  const hasSwissCountrySignal = /\b(?:ch|che|swiss|switzerland|schweiz|suisse|svizzera)\b/i.test(value);
  // "Remote" is not a country signal: an unqualified remote posting may be
  // outside Switzerland. Keep it only when Workday corroborates Switzerland
  // in the same candidate or in another candidate in the list.
  if (!hasSwissCountrySignal) {
    return false;
  }

  const residue = value
    .replace(/\b(?:remote|ch|che|swiss|switzerland|schweiz|suisse|svizzera)\b/gi, '')
    .replace(/[\s,;|/()_-]+/g, '');
  return residue === '';
}

/**
 * Does the req's OWN primary workplace license a Swiss publication?
 *
 * `candidates[0]` is the req's primary Workday location (`info.location`) by
 * construction in both callers; the rest of the list is cross-post entries,
 * the requisition object and the listing summary. Deciding to publish from the
 * UNION lets a req worked in Frankfurt that merely lists `Switzerland` among
 * its other locations reach the country-only branch below, which then
 * fabricates `addressLocality: Bern, addressRegion: BE` for a foreign
 * vacancy. `location: 'Switzerland'` is honest and stays; a made-up Bern
 * address for a foreign primary is the defect.
 *
 * Measured 2026-09-19 on the published slice `data/jobs/by-crawler/fnz.json`:
 * 1 record, resolved from its own primary (`/job/Chiasso---Switzerland/` →
 * Chiasso / TI), and 0 records currently carry `nationalFallback` — so the
 * defect is LATENT and this guard drops nothing that is published today.
 *
 * Exported so the call site cannot drift back to the union without breaking
 * the test that names this rule.
 */
export function hasFnzSwissPrimaryLocation(candidates = []) {
  const primary = (Array.isArray(candidates) ? candidates : [])[0];
  const { signal } = normalizeCandidate(primary);
  if (!signal) return false;
  return isCountryOnlySwissSignal(signal) || isSwissLocationText(signal);
}

/**
 * Resolve a Workday posting to a concrete Swiss location. Workday may put a
 * country-only value before a more specific additional location, so all
 * candidates are inspected before accepting one. If no candidate supplies a
 * concrete municipality, preserve a country-only Swiss posting with an
 * unresolved public location and a coherent national address fallback.
 *
 * Fail closed on the primary first: enriching a Swiss (or Swiss-country-only)
 * primary from a later candidate is legitimate, publishing a req whose own
 * primary is foreign is not.
 */
export function resolveFnzSwissLocation(candidates = []) {
  if (!hasFnzSwissPrimaryLocation(candidates)) return null;

  let countryOnlyFallback = null;

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const { raw, signal, city, hasStructuredAddress } = normalizeCandidate(candidate);
    const countryOnly = isCountryOnlySwissSignal(signal);
    if (!raw || !signal || (!countryOnly && !isSwissLocationText(signal))) continue;

    // Search the complete source signal before falling back to the ATS's first
    // segment. This covers `location: Switzerland` plus a richer
    // jobRequisitionLocation/address/postalCode object without losing the
    // source location provenance.
    const explicitCity = swissCityFromLocationField(city);
    const signalCity = swissCityFromLocationField(signal);
    const resolvedLocation = explicitCity || signalCity;
    const location = resolvedLocation || city || firstLocationSegment(raw);
    const signalCanton = inferAnyCanton(signal);
    const locationCanton = inferAnyCanton(location);
    // A city and a richer address signal must describe the same canton. If
    // they disagree, reject the candidate rather than emit plausible-looking
    // but internally inconsistent structured data. A city field or structured
    // address is authoritative; a city inferred from the aggregate signal
    // must still be non-canton-only before it can bypass that guard.
    const locationIsConcreteCity = Boolean(
      location
      && locationCanton
      && (
        explicitCity
        || hasStructuredAddress
        || (signalCity && !isCantonOnlyLabel(signalCity))
      ),
    );
    if (
      locationIsConcreteCity
      && (!signalCanton || signalCanton === locationCanton)
      && !/^\s*(?:switzerland|schweiz|suisse|svizzera|swiss)\s*$/i.test(location)
    ) {
      const canton = signalCanton || locationCanton;
      return { raw, location, canton };
    }

    if (countryOnly && !signalCanton && !countryOnlyFallback) {
      countryOnlyFallback = {
        raw,
        location: 'Switzerland',
        canton: '',
        nationalFallback: true,
        ...FNZ_NATIONAL_ADDRESS_FALLBACK,
      };
    }

  }

  return countryOnlyFallback;
}
