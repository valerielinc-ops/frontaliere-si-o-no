import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import { inferAnyCanton, isSwissLocationText } from './target-swiss-locations.mjs';

const SWISS_COUNTRY_ONLY_RE = /^\s*(?:switzerland|schweiz|suisse|svizzera|swiss)\s*$/i;

/**
 * Resolve a Workday posting to a Swiss location without inventing an HQ city.
 * Workday may put a country-only value before a more specific additional
 * location, so all candidates are inspected before accepting one.
 */
export function resolveFnzSwissLocation(candidates = []) {
  let countryOnlyRaw = '';

  for (const rawCandidate of candidates) {
    const raw = String(rawCandidate || '').trim();
    if (!raw || !isSwissLocationText(raw)) continue;

    const location = firstLocationSegment(raw) || raw;
    const canton = inferAnyCanton(location) || inferAnyCanton(raw);
    if (canton) return { raw, location, canton };

    // Preserve an authoritative country-only Workday value instead of
    // inventing a city. Prefer any more specific Swiss candidate later in the
    // list; keep this only as the safe source-level fallback.
    if (!countryOnlyRaw && SWISS_COUNTRY_ONLY_RE.test(raw)) countryOnlyRaw = raw;
  }

  // A country-only Workday posting is still an authoritative Swiss result;
  // return the source value explicitly instead of letting the caller drop it.
  if (countryOnlyRaw) {
    return { raw: countryOnlyRaw, location: countryOnlyRaw, canton: '' };
  }
  return null;
}
