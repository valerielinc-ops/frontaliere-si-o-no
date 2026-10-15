import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve the per-vacancy Swiss locality from VF's Workday location label.
 *
 * Workday currently emits hierarchical labels such as
 * `EMEA · CHE · Stabio · VF Campus VF1`. The country token is not a locality;
 * split the label, find the concrete Swiss city, and infer its canton from the
 * same signal. Foreign or country-only labels fail closed.
 */
export function resolveVfSwissLocation(rawLocation = '') {
  const normalized = normalizeSpace(rawLocation);
  if (!normalized) return null;

  const segments = normalized
    .split(/\s*[·|]\s*/)
    .map(normalizeSpace)
    .filter(Boolean);
  const candidates = [...segments, normalized];

  for (const candidate of candidates) {
    if (!isTargetSwissLocation(candidate, { includeBorderProximity: false })) continue;
    const canton = inferAnyCanton(candidate);
    if (canton) return { locality: candidate, canton };
  }
  return null;
}
