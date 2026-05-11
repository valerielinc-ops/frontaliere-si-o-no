// scripts/lib/discovery/sources/googleSuggestSource.mjs
//
// Discovery source: Google Suggest autocomplete. Wraps the existing
// fetcher in scripts/lib/topic-sources/googleSuggest.mjs.
//
// Seeds: top cluster keywords from `evidence.clusterStats` ranked by p50
// descending. Falls back to the static SEEDS_FALLBACK list inside the
// underlying fetcher when no clusterStats are present.
//
// Output: candidates with `source: 'suggest'`. Suggestions whose
// (lowercased) text equals any existing key in `evidence.gsc.queries`
// are dropped — those are NOT discovery (the topic is already proven).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.3.2

import { fetchSuggestCandidates } from '../../topic-sources/googleSuggest.mjs';
import { anchorSeed, hasDomainAnchor } from '../domainAnchor.mjs';

const SOURCE_TAG = 'suggest';
const MAX_SEEDS = 8;

/**
 * @typedef {{
 *   headline: string,
 *   url: null,
 *   source: 'suggest',
 *   meta: { seed: string, rank: number, normalizedKeyword: string },
 * }} SuggestCandidate
 */

/**
 * Pick the top cluster names to seed Google Suggest. We ignore the
 * `generic` bucket (too noisy a seed) and any cluster lacking a
 * numeric p50.
 *
 * @param {object} clusterStats
 * @returns {string[]}
 */
export function pickClusterSeeds(clusterStats) {
  if (!clusterStats || typeof clusterStats !== 'object') return [];
  const entries = Object.entries(clusterStats)
    .filter(([name, stats]) => name !== 'generic' && stats && Number.isFinite(Number(stats.p50)))
    .map(([name, stats]) => ({ name, p50: Number(stats.p50) }));
  entries.sort((a, b) => b.p50 - a.p50);
  // Compose each cluster with a domain anchor so Google Suggest can't
  // bridge bare cluster words ("mobilita") into off-topic Italian
  // searches ("mobilita palermo"). See domainAnchor.mjs for rationale.
  return entries.slice(0, MAX_SEEDS).map((e) => anchorSeed(e.name));
}

function buildProvenSet(gscBlock) {
  const set = new Set();
  if (gscBlock && gscBlock.queries && typeof gscBlock.queries === 'object') {
    for (const key of Object.keys(gscBlock.queries)) {
      if (typeof key === 'string' && key.trim()) set.add(key.trim().toLowerCase());
    }
  }
  return set;
}

/**
 * Fetch Google Suggest discovery candidates. Returns [] on fetcher
 * failure — never throws.
 *
 * @param {object} evidence
 * @param {{ fetchImpl?: Function, suggestFn?: Function, seeds?: string[] }} [opts]
 * @returns {Promise<SuggestCandidate[]>}
 */
export async function fetchSuggestDiscoveryCandidates(evidence, opts = {}) {
  const suggestFn = opts.suggestFn || fetchSuggestCandidates;
  const provenSet = buildProvenSet(evidence?.gsc);

  const seeds = Array.isArray(opts.seeds) && opts.seeds.length > 0
    ? opts.seeds
    : pickClusterSeeds(evidence?.clusterStats);

  let result;
  try {
    result = await suggestFn({
      seeds: seeds.length > 0 ? seeds : undefined,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    console.warn(`[discovery/suggest] fetcher threw: ${err?.message || err}`);
    return [];
  }
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];

  const seenHeadlines = new Set();
  const out = [];
  for (const c of candidates) {
    const headline = String(c?.keyword || '').trim();
    if (!headline) continue;
    const lower = headline.toLowerCase();
    if (provenSet.has(lower)) continue;
    if (seenHeadlines.has(lower)) continue;
    // Domain anchor gate — discovery is only meaningful when the
    // candidate is plausibly about Ticino frontalieri. Suggest
    // routinely returns generic-Italian completions even from
    // anchored seeds (Google falls back to seed-prefix matches).
    if (!hasDomainAnchor(headline)) continue;
    seenHeadlines.add(lower);
    out.push({
      headline,
      url: null,
      source: SOURCE_TAG,
      meta: {
        seed: c?.demandSignals?.googleSuggestSeed || null,
        rank: Number.isFinite(c?.demandSignals?.googleSuggestRank)
          ? Number(c.demandSignals.googleSuggestRank)
          : null,
        normalizedKeyword: c?.normalizedKeyword || lower,
      },
    });
  }
  return out;
}

export default fetchSuggestDiscoveryCandidates;
