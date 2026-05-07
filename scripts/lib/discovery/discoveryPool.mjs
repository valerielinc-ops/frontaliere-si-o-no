// scripts/lib/discovery/discoveryPool.mjs
//
// Orchestrates the three discovery sources (orphan + suggest + news),
// applies cross-pool deduplication against the proven pool's headlines,
// and returns the merged candidate list with discovery scores attached.
//
// Per-source kill switches honored (spec § 13.2 rollback levers):
//   DISABLE_DISCOVERY_ORPHAN=1
//   DISABLE_DISCOVERY_SUGGEST=1
//   DISABLE_DISCOVERY_NEWS=1
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3-6.5

import { fetchOrphanCandidates } from './sources/orphanQuerySource.mjs';
import { fetchSuggestDiscoveryCandidates } from './sources/googleSuggestSource.mjs';
import { fetchNewsRssDiscoveryCandidates } from './sources/googleNewsRssSource.mjs';
import { discoveryScore } from './discoveryScore.mjs';
import { isNearDuplicate, SLUG_SIMILARITY_THRESHOLD } from '../scheduler/slugSimilarity.mjs';

const ENV_TRUE = (val) => val === '1' || val === 'true';

function isOrphanDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_ORPHAN);
}
function isSuggestDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_SUGGEST);
}
function isNewsDisabled() {
  return ENV_TRUE(process.env.DISABLE_DISCOVERY_NEWS);
}

/**
 * @typedef {{
 *   headline: string,
 *   url: string|null,
 *   source: 'orphan'|'suggest'|'news',
 *   meta: object,
 * }} DiscoveryCandidate
 *
 * @typedef {DiscoveryCandidate & {
 *   _scoreBreakdown: object,
 *   _discoveryScore: number,
 * }} ScoredDiscoveryCandidate
 */

/**
 * Fetch discovery candidates from all enabled sources. Per-source
 * failures are logged but never fatal — the pool returns whatever the
 * other sources produced.
 *
 * @param {object} evidence
 * @param {{
 *   fetchImpl?: Function,
 *   orphanFn?: Function,
 *   suggestFn?: Function,
 *   newsFn?: Function,
 * }} [opts]
 * @returns {Promise<{ candidates: DiscoveryCandidate[], perSource: Record<string, number> }>}
 */
export async function fetchAll(evidence, opts = {}) {
  const orphanFn = opts.orphanFn || fetchOrphanCandidates;
  const suggestFn = opts.suggestFn || fetchSuggestDiscoveryCandidates;
  const newsFn = opts.newsFn || fetchNewsRssDiscoveryCandidates;
  const perSource = { orphan: 0, suggest: 0, news: 0 };
  const merged = [];

  // Orphan — synchronous (reads from evidence in-memory).
  if (!isOrphanDisabled()) {
    try {
      const orphans = orphanFn(evidence) || [];
      perSource.orphan = orphans.length;
      for (const c of orphans) merged.push(c);
    } catch (err) {
      console.warn(`[discovery] orphan source failed: ${err?.message || err}`);
    }
  }

  // Suggest + news — fetch in parallel; both already swallow errors.
  const remoteJobs = [];
  if (!isSuggestDisabled()) {
    remoteJobs.push(
      suggestFn(evidence, { fetchImpl: opts.fetchImpl })
        .then((arr) => ({ kind: 'suggest', arr: Array.isArray(arr) ? arr : [] }))
        .catch((err) => {
          console.warn(`[discovery] suggest source failed: ${err?.message || err}`);
          return { kind: 'suggest', arr: [] };
        }),
    );
  }
  if (!isNewsDisabled()) {
    remoteJobs.push(
      newsFn(evidence, { fetchImpl: opts.fetchImpl })
        .then((arr) => ({ kind: 'news', arr: Array.isArray(arr) ? arr : [] }))
        .catch((err) => {
          console.warn(`[discovery] news source failed: ${err?.message || err}`);
          return { kind: 'news', arr: [] };
        }),
    );
  }

  const remoteResults = await Promise.all(remoteJobs);
  for (const r of remoteResults) {
    perSource[r.kind] = r.arr.length;
    for (const c of r.arr) merged.push(c);
  }

  return { candidates: merged, perSource };
}

/**
 * Drop candidates whose headline is similar (Jaccard >= threshold) to
 * any string in `provenHeadlines`. Logs the count of dropped entries.
 *
 * @param {DiscoveryCandidate[]} candidates
 * @param {string[]} provenHeadlines
 * @param {number} [threshold]
 * @returns {DiscoveryCandidate[]}
 */
export function dedupAgainstProven(candidates, provenHeadlines, threshold = SLUG_SIMILARITY_THRESHOLD) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!Array.isArray(provenHeadlines) || provenHeadlines.length === 0) return candidates.slice();
  const kept = [];
  let dropped = 0;
  for (const c of candidates) {
    if (isNearDuplicate(c.headline, provenHeadlines, threshold)) {
      dropped += 1;
      continue;
    }
    kept.push(c);
  }
  if (dropped > 0) {
    console.error(`DISCOVERY_CROSS_POOL_DEDUP dropped=${dropped} kept=${kept.length} threshold=${threshold}`);
  }
  return kept;
}

/**
 * Attach a discovery-score breakdown to every candidate. Sorted by
 * `_discoveryScore` desc.
 *
 * @param {DiscoveryCandidate[]} candidates
 * @param {object} evidence
 * @returns {ScoredDiscoveryCandidate[]}
 */
export function scoreCandidates(candidates, evidence) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scored = [];
  for (const c of candidates) {
    let breakdown;
    try {
      breakdown = discoveryScore(c, evidence);
    } catch (err) {
      console.warn(`[discovery] scoring failed for "${String(c.headline).slice(0, 60)}": ${err?.message || err}`);
      continue;
    }
    scored.push({
      ...c,
      _scoreBreakdown: breakdown,
      _discoveryScore: Number(breakdown.finalScore) || 0,
    });
  }
  scored.sort((a, b) => b._discoveryScore - a._discoveryScore);
  return scored;
}

/**
 * One-shot convenience: fetch + dedup + score. Returns the sorted list.
 *
 * @param {object} evidence
 * @param {{ provenHeadlines?: string[], fetchImpl?: Function, orphanFn?: Function, suggestFn?: Function, newsFn?: Function, dedupThreshold?: number }} [opts]
 * @returns {Promise<{ candidates: ScoredDiscoveryCandidate[], perSource: Record<string, number>, postDedupCount: number }>}
 */
export async function buildDiscoveryPool(evidence, opts = {}) {
  const { candidates, perSource } = await fetchAll(evidence, opts);
  const proven = Array.isArray(opts.provenHeadlines) ? opts.provenHeadlines : [];
  const deduped = dedupAgainstProven(candidates, proven, opts.dedupThreshold);
  const scored = scoreCandidates(deduped, evidence);
  return { candidates: scored, perSource, postDedupCount: deduped.length };
}

export default buildDiscoveryPool;
