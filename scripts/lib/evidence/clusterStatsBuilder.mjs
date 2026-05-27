// Cluster stats builder — computes p10/p50/p90 of `sessions` per cluster
// from GA4 page data. Articles must be ≥CLUSTER_RAMPUP_DAYS old to enter
// the stats (so we don't bias toward freshly-published, not-yet-ramped pieces).

import { CLUSTER_MIN_N, CLUSTER_RAMPUP_DAYS } from './constants.mjs';

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

/**
 * @param {object} ga4Pages - keyed by path; each entry has { sessions, publishedAt, cluster }
 * @param {object} [options]
 * @param {number} [options.now=Date.now()] - for deterministic tests
 * @returns {object} clusterStats keyed by cluster name → { p10, p50, p90, n }
 */
export function buildClusterStats(ga4Pages, { now = Date.now() } = {}) {
  const minAgeMs = CLUSTER_RAMPUP_DAYS * 24 * 3600 * 1000;
  const sessionsByCluster = new Map();
  const allSessions = [];

  for (const path in ga4Pages) {
    const entry = ga4Pages[path];
    if (!entry) continue;
    const { sessions, publishedAt, cluster } = entry;
    if (publishedAt == null) continue;
    const publishedTs = Date.parse(publishedAt);
    if (Number.isNaN(publishedTs)) continue;
    if (now - publishedTs < minAgeMs) continue;
    const clusterKey = cluster || 'generic';
    if (!sessionsByCluster.has(clusterKey)) sessionsByCluster.set(clusterKey, []);
    sessionsByCluster.get(clusterKey).push(sessions || 0);
    allSessions.push(sessions || 0);
  }

  const stats = {};
  for (const [cluster, arr] of sessionsByCluster) {
    if (arr.length < CLUSTER_MIN_N) {
      // Insufficient sample — record n for transparency but don't compute percentiles.
      stats[cluster] = { p10: 0, p50: 0, p90: 0, n: arr.length };
      continue;
    }
    const sorted = arr.slice().sort((a, b) => a - b);
    stats[cluster] = {
      p10: percentile(sorted, 0.1),
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      n: arr.length,
    };
  }

  // Always compute a `global` aggregate as a last-resort cluster fallback floor.
  if (allSessions.length >= CLUSTER_MIN_N) {
    const sorted = allSessions.slice().sort((a, b) => a - b);
    stats.global = {
      p10: percentile(sorted, 0.1),
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      n: allSessions.length,
    };
  } else {
    stats.global = { p10: 0, p50: 0, p90: 0, n: allSessions.length };
  }

  return stats;
}
