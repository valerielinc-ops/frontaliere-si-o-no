/**
 * Queue policy for TRACE.
 *
 * Candidates with a live SECO ad are the strongest signal that an employer is
 * recruiting now. They must therefore outrank the much larger OSM backlog,
 * even when the OSM candidate already has a domain and the SECO candidate does
 * not. Within each demand bucket we keep the cheap, already-resolved domains
 * first, then serve the oldest candidates first so a long queue cannot starve
 * small employers discovered earlier.
 */

/** @param {Record<string, any>} candidate */
function hasActiveDemand(candidate) {
  return Number(candidate?.adCount) > 0;
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {number}
 */
export function compareTraceCandidates(a, b) {
  const demand = Number(hasActiveDemand(b)) - Number(hasActiveDemand(a));
  if (demand) return demand;

  // Domain-known candidates still save the expensive name-to-domain lookup.
  const resolved = Number(Boolean(b?.domain)) - Number(Boolean(a?.domain));
  if (resolved) return resolved;

  const seen = String(a?.firstSeenAt || a?.updatedAt || '').localeCompare(
    String(b?.firstSeenAt || b?.updatedAt || ''),
  );
  if (seen) return seen;

  // A high ad count is a useful tie-breaker, not a queue monopoly: the goal is
  // to discover more employers, not to spend the whole budget on one agency
  // reported from many towns.
  const ads = Number(b?.adCount || 0) - Number(a?.adCount || 0);
  return ads || String(a?.key || '').localeCompare(String(b?.key || ''));
}

/**
 * @param {Record<string, any>[]} candidates
 * @param {number} limit
 * @returns {Record<string, any>[]}
 */
export function prioritizeTraceCandidates(candidates, limit) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : candidates.length;
  return candidates.slice().sort(compareTraceCandidates).slice(0, max);
}
