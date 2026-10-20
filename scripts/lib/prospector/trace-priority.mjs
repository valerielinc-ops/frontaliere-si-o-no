/**
 * Queue policy for TRACE.
 *
 * Direct careers URLs and employer domains are observed leads, so they outrank
 * name-only guesses. Recent SECO listings come next, but old ad counts do not
 * remain a permanent priority signal. The 5:3:2:1 queue weights reserve about
 * 9% of a full batch for fallback candidates (no current direct URL, domain, or
 * recent SECO evidence); empty buckets donate their share to buckets with work.
 */

export const TRACE_SECO_FRESHNESS_DAYS = 30;
const TRACE_SECO_FRESHNESS_MS = TRACE_SECO_FRESHNESS_DAYS * 86_400_000;
const TRACE_BUCKETS = Object.freeze([
  { key: 'careersUrl', weight: 5, matches: (candidate) => Boolean(candidate?.careersUrl) },
  { key: 'domain', weight: 3, matches: (candidate) => Boolean(candidate?.domain) },
  { key: 'recentSeco', weight: 2, matches: (candidate, now) => hasRecentSecoDemand(candidate, now) },
  { key: 'fallback', weight: 1, matches: () => true },
]);

/**
 * @param {Record<string, any>} candidate
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasRecentSecoDemand(candidate, now = Date.now()) {
  if (!(Number(candidate?.adCount) > 0)) return false;
  const observedAt = Date.parse(String(candidate?.sourceSeenAt?.seco || ''));
  const age = now - observedAt;
  return Number.isFinite(observedAt) && age >= 0 && age <= TRACE_SECO_FRESHNESS_MS;
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @param {number} [now]
 * @returns {number}
 */
export function compareTraceCandidates(a, b, now = Date.now()) {
  const directCareers = Number(Boolean(b?.careersUrl)) - Number(Boolean(a?.careersUrl));
  if (directCareers) return directCareers;

  const resolved = Number(Boolean(b?.domain)) - Number(Boolean(a?.domain));
  if (resolved) return resolved;

  const recentDemand = Number(hasRecentSecoDemand(b, now)) - Number(hasRecentSecoDemand(a, now));
  if (recentDemand) return recentDemand;

  if (hasRecentSecoDemand(a, now) && hasRecentSecoDemand(b, now)) {
    const fresh = String(b.sourceSeenAt.seco).localeCompare(String(a.sourceSeenAt.seco));
    if (fresh) return fresh;
    const ads = Number(b.adCount || 0) - Number(a.adCount || 0);
    if (ads) return ads;
  }

  const seen = String(a?.firstSeenAt || a?.updatedAt || '').localeCompare(
    String(b?.firstSeenAt || b?.updatedAt || ''),
  );
  return seen || String(a?.key || '').localeCompare(String(b?.key || ''));
}

/**
 * @param {Record<string, any>[]} candidates
 * @param {number} limit
 * @param {number} [now]
 * @returns {Record<string, any>[]}
 */
export function prioritizeTraceCandidates(candidates, limit, now = Date.now()) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : candidates.length;
  if (!max) return [];

  const buckets = Object.fromEntries(TRACE_BUCKETS.map(({ key }) => [key, []]));
  for (const candidate of candidates) {
    const bucket = TRACE_BUCKETS.find(({ matches }) => matches(candidate, now));
    buckets[bucket.key].push(candidate);
  }
  for (const bucket of TRACE_BUCKETS) {
    buckets[bucket.key].sort((a, b) => compareTraceCandidates(a, b, now));
  }

  const selectedCounts = Object.fromEntries(TRACE_BUCKETS.map(({ key }) => [key, 0]));
  const selected = [];

  // Weighted fair allocation yields 5/3/2/1 at limit 11. A bucket at capacity
  // drops out, so its remaining share is redistributed over the other buckets.
  // Keeping fallback in the same allocation prevents a persistent primary
  // backlog from indefinitely postponing candidates with weaker evidence.
  const candidateCount = TRACE_BUCKETS.reduce((count, { key }) => count + buckets[key].length, 0);
  for (let slot = 0; slot < Math.min(max, candidateCount); slot += 1) {
    const available = TRACE_BUCKETS.filter(({ key }) => selectedCounts[key] < buckets[key].length);
    available.sort((a, b) => {
      const aNextShare = (selectedCounts[a.key] + 1) / a.weight;
      const bNextShare = (selectedCounts[b.key] + 1) / b.weight;
      return aNextShare - bNextShare
        || TRACE_BUCKETS.indexOf(a) - TRACE_BUCKETS.indexOf(b);
    });
    const bucket = available[0];
    selected.push(buckets[bucket.key][selectedCounts[bucket.key]]);
    selectedCounts[bucket.key] += 1;
  }

  return selected;
}
