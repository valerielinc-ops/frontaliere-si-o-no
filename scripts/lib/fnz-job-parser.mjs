import { firstLocationSegment } from './ats-clients/workday-client.mjs';
import { inferAnyCanton, isSwissLocationText } from './target-swiss-locations.mjs';

function normalizeCandidate(candidate) {
  if (candidate && typeof candidate === 'object') {
    return {
      raw: String(candidate.descriptor || candidate.name || candidate.location || '').trim(),
      city: String(candidate.addressLocality || '').trim(),
    };
  }
  return { raw: String(candidate || '').trim(), city: '' };
}

/**
 * Resolve a Workday posting to a concrete Swiss location. Workday may put a
 * country-only value before a more specific additional location, so all
 * candidates are inspected before accepting one. A country-only value is not
 * a city and therefore returns null; the FNZ updater applies its separately
 * confirmed Zürich fallback at the publication boundary.
 */
export function resolveFnzSwissLocation(candidates = []) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const { raw, city } = normalizeCandidate(candidate);
    if (!raw || !isSwissLocationText(raw)) continue;

    const location = city || firstLocationSegment(raw) || raw;
    const canton = inferAnyCanton(location) || inferAnyCanton(raw);
    if (canton) return { raw, location, canton };
  }

  return null;
}
