// scripts/lib/demand-vocabulary.mjs
//
// Phase A — Aggregate stable demand signals into a "demand vocabulary"
// scoring dict. Phase B+C will consume `data/demand-vocabulary.json` to
// rerank the news pool inside `create-article.mjs`.
//
// Stable sources (this module):
//   1. GSC orphan queries  — gscImpressions normalized to /500
//   2. Google Suggest      — completions ranked 0..9 (top → bottom)
//   3. winnerFingerprint   — topClusters / topKeywords from
//      `data/article-performance.json`
//
// Output schema (data/demand-vocabulary.json):
//   {
//     "generatedAt": "ISO-8601",
//     "weights": { "gsc": 0.4, "suggest": 0.3, "fingerprint": 0.3 },
//     "stableKeywords": [
//       { "kw", "normalizedKeyword", "weight", "source", "cluster" }
//     ],
//     "sources": {
//       "gscOrphans": { "ok", "kw_count" },
//       "googleSuggest": { "ok", "kw_count" },
//       "winnerFingerprint": { "ok", "kw_count" }
//     }
//   }
//
// Resilience: never throws. If a single source fails, the others still
// produce vocab; if all fail, an empty-but-valid vocab is returned.

import { existsSync, readFileSync } from 'node:fs';

import { fetchGscOrphanCandidates, normalizeKeyword } from './topic-sources/gscOrphans.mjs';
import { fetchSuggestCandidates } from './topic-sources/googleSuggest.mjs';
import { classifyByRegex, CLUSTER_TAXONOMY } from './cluster-classifier-prompt.mjs';

const DEFAULT_WEIGHTS = { gsc: 0.4, suggest: 0.3, fingerprint: 0.3 };
const WEIGHT_FLOOR = 0.01; // drop kw below this combined weight
const FINGERPRINT_PATH_DEFAULT = 'data/article-performance.json';

function loadJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function round3(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

// Given a normalized keyword (already lowercased + diacritics-stripped),
// produce its cluster via the regex priority list. Phase B+C will replace
// this with an LLM batch + regex defense-in-depth; Phase A is regex only.
function clusterFor(text) {
  return classifyByRegex(text);
}

// Per-source weight functions. All return [0, sourceWeight].
function gscWeight(impressions, weights) {
  if (!Number.isFinite(impressions) || impressions <= 0) return 0;
  return Math.min(impressions / 500, 1) * weights.gsc;
}

function suggestWeight(rank, weights) {
  if (!Number.isFinite(rank) || rank < 0) return 0;
  // rank 0 = top → full weight; rank 9 → 0.1 of the source weight
  const rankFactor = Math.max(0, 1 - rank / 10);
  return rankFactor * weights.suggest;
}

function fingerprintWeight(weights) {
  // Boolean signal: keyword present in fingerprint.topKeywords → full
  // source weight; otherwise 0. Phase B+C may smooth this with cluster
  // weights, but A keeps the boolean for simplicity.
  return weights.fingerprint;
}

// Read the winnerFingerprint into a normalized signal set:
//  - topKeywordsNorm: Set<string> of normalized keywords
//  - clusterWeights:  Record<cluster, weight 0..1>
function readFingerprint(fingerprintPath) {
  const data = loadJsonSafe(fingerprintPath);
  const fp = data?.winnerFingerprint;
  if (!fp || typeof fp !== 'object') {
    return { ok: false, topKeywordsNorm: new Set(), clusterWeights: {} };
  }
  const topKeywordsNorm = new Set();
  if (Array.isArray(fp.topKeywords)) {
    for (const kw of fp.topKeywords) {
      const norm = normalizeKeyword(kw);
      if (norm) topKeywordsNorm.add(norm);
    }
  }
  const clusterWeights = {};
  if (Array.isArray(fp.topClusters)) {
    for (const entry of fp.topClusters) {
      if (!entry || typeof entry !== 'object') continue;
      const c = String(entry.cluster ?? '').trim();
      const w = Number(entry.weight ?? 0);
      if (c && CLUSTER_TAXONOMY.includes(c) && Number.isFinite(w)) {
        clusterWeights[c] = w;
      }
    }
  }
  return { ok: true, topKeywordsNorm, clusterWeights };
}

// Build per-keyword aggregation map. Each entry tracks weight breakdown
// and which sources contributed so we can emit the merged source label.
function aggregate({
  gscCandidates,
  suggestCandidates,
  fingerprint,
  weights,
}) {
  /** @type {Map<string, {kw: string, normalizedKeyword: string, sources: Set<string>, weight: number}>} */
  const byKw = new Map();
  const upsert = (rawKw, normKw, source, weightContribution) => {
    if (!normKw) return;
    if (!Number.isFinite(weightContribution) || weightContribution <= 0) return;
    const existing = byKw.get(normKw);
    if (existing) {
      existing.sources.add(source);
      existing.weight += weightContribution;
      // Prefer the longer surface form (more descriptive when present).
      if (typeof rawKw === 'string' && rawKw.length > existing.kw.length) {
        existing.kw = rawKw;
      }
    } else {
      byKw.set(normKw, {
        kw: rawKw,
        normalizedKeyword: normKw,
        sources: new Set([source]),
        weight: weightContribution,
      });
    }
  };

  // 1. GSC orphans
  for (const c of gscCandidates) {
    const norm = c.normalizedKeyword || normalizeKeyword(c.keyword);
    if (!norm) continue;
    const impressions = Number(c?.demandSignals?.gscImpressions ?? 0);
    const w = gscWeight(impressions, weights);
    if (w > 0) upsert(c.keyword, norm, 'gsc', w);
  }

  // 2. Google Suggest
  for (const c of suggestCandidates) {
    const norm = c.normalizedKeyword || normalizeKeyword(c.keyword);
    if (!norm) continue;
    const rank = Number(c?.demandSignals?.googleSuggestRank ?? 0);
    const w = suggestWeight(rank, weights);
    if (w > 0) upsert(c.keyword, norm, 'suggest', w);
  }

  // 3. winnerFingerprint topKeywords
  const fpW = fingerprintWeight(weights);
  for (const norm of fingerprint.topKeywordsNorm) {
    if (!norm) continue;
    upsert(norm, norm, 'fingerprint', fpW);
  }

  return byKw;
}

function sourceLabel(sources) {
  // Stable canonical ordering so the same set always serializes the same.
  const order = ['gsc', 'suggest', 'fingerprint'];
  return order.filter((s) => sources.has(s)).join('+');
}

function compareStableKeyword(a, b) {
  if (b.weight !== a.weight) return b.weight - a.weight;
  return a.normalizedKeyword.localeCompare(b.normalizedKeyword);
}

/**
 * Build the demand vocabulary by aggregating GSC orphans + Google Suggest
 * + winnerFingerprint. Always resolves; never throws.
 *
 * @param {object} [opts]
 * @param {Function} [opts.gscOrphansImpl]
 * @param {Function} [opts.suggestImpl]
 * @param {string}   [opts.fingerprintPath]
 * @param {{gsc:number, suggest:number, fingerprint:number}} [opts.weights]
 * @param {() => string} [opts.now]
 * @returns {Promise<{
 *   generatedAt: string,
 *   weights: object,
 *   stableKeywords: Array<{kw:string, normalizedKeyword:string, weight:number, source:string, cluster:string}>,
 *   sources: Record<string, {ok:boolean, kw_count:number, reason?:string}>
 * }>}
 */
export async function buildDemandVocabulary(opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const gscOrphansImpl = opts.gscOrphansImpl ?? fetchGscOrphanCandidates;
  const suggestImpl = opts.suggestImpl ?? fetchSuggestCandidates;
  const fingerprintPath = opts.fingerprintPath ?? FINGERPRINT_PATH_DEFAULT;
  const now = opts.now ?? (() => new Date().toISOString());

  // Run sources sequentially (matches mine-topic-candidates.mjs pattern;
  // these are I/O-bound but already self-throttled).
  let gscRes;
  try {
    gscRes = await gscOrphansImpl();
  } catch (e) {
    gscRes = { ok: false, candidates: [], reason: `unhandled: ${e?.message ?? String(e)}` };
  }
  let suggestRes;
  try {
    suggestRes = await suggestImpl();
  } catch (e) {
    suggestRes = { ok: false, candidates: [], reason: `unhandled: ${e?.message ?? String(e)}` };
  }

  const fingerprint = readFingerprint(fingerprintPath);

  const gscCandidates = Array.isArray(gscRes?.candidates) ? gscRes.candidates : [];
  const suggestCandidates = Array.isArray(suggestRes?.candidates) ? suggestRes.candidates : [];

  const byKw = aggregate({
    gscCandidates,
    suggestCandidates,
    fingerprint,
    weights,
  });

  const stableKeywords = [];
  for (const v of byKw.values()) {
    if (v.weight < WEIGHT_FLOOR) continue;
    stableKeywords.push({
      kw: v.kw,
      normalizedKeyword: v.normalizedKeyword,
      weight: round3(v.weight),
      source: sourceLabel(v.sources),
      cluster: clusterFor(v.normalizedKeyword),
    });
  }
  stableKeywords.sort(compareStableKeyword);

  const sources = {
    gscOrphans: {
      ok: !!gscRes?.ok,
      kw_count: gscCandidates.length,
      ...(gscRes?.reason ? { reason: gscRes.reason } : {}),
    },
    googleSuggest: {
      ok: !!suggestRes?.ok,
      kw_count: suggestCandidates.length,
      ...(suggestRes?.reason ? { reason: suggestRes.reason } : {}),
    },
    winnerFingerprint: {
      ok: !!fingerprint.ok,
      kw_count: fingerprint.topKeywordsNorm.size,
    },
  };

  return {
    generatedAt: now(),
    weights,
    stableKeywords,
    sources,
  };
}

export default buildDemandVocabulary;
