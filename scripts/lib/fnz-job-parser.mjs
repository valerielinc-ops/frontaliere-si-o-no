import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import { inferAnyCanton, isSwissLocationText } from './target-swiss-locations.mjs';

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
    if (!canton) continue;

    return { raw, location, canton };
  }

  return null;
}
