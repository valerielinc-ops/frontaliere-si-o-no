import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import { inferAnyCanton, isSwissLocationText } from './target-swiss-locations.mjs';

const SWISS_COUNTRY_ONLY_RE = /^\s*(?:switzerland|schweiz|suisse|svizzera|swiss)\s*$/i;

export function resolveFnzSwissCountryLocation(candidates = []) {
  for (const rawCandidate of candidates) {
    const raw = String(rawCandidate || '').trim();
    if (SWISS_COUNTRY_ONLY_RE.test(raw) && isSwissLocationText(raw)) {
      return { raw, location: raw, canton: '' };
    }
  }
  return null;
}

/**
 * Resolve a Workday posting to a Swiss location without inventing an HQ city.
 * Workday may put a country-only value before a more specific additional
 * location, so all candidates are inspected before accepting one.
 */
export function resolveFnzSwissLocation(candidates = []) {
  for (const rawCandidate of candidates) {
    const raw = String(rawCandidate || '').trim();
    if (!raw || !isSwissLocationText(raw)) continue;

    const location = firstLocationSegment(raw) || raw;
    const canton = inferAnyCanton(location) || inferAnyCanton(raw);
    if (canton) return { raw, location, canton };
  }

  // A country-only Workday posting is still an authoritative Swiss result;
  // return the source value explicitly instead of letting the caller drop it.
  return resolveFnzSwissCountryLocation(candidates);
}
