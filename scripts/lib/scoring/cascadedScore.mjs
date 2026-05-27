// scripts/lib/scoring/cascadedScore.mjs
//
// Phase 2 cascaded scoring. Replaces TF-IDF demand-vocabulary scoring.
//
// Cascade (stops at first non-null stage):
//   1. GSC keyword bridge      — confidence 1.0
//   2. Embedding similarity    — confidence 0.8 (calls OpenAI embeddings)
//   3. Cluster median fallback — confidence 0.3
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 5.4-5.7

import { extractTerms } from './termExtractor.mjs';
import { findTopK, cosineSimilarity } from './embeddingMatcher.mjs';
import { embedOne } from '../evidence/embeddingClient.mjs';
import { classifyByRegex } from '../cluster-classifier-prompt.mjs';
import {
  GSC_MIN_SIGNAL,
  EMBEDDING_MIN_COSINE,
  CONFIDENCE_GSC,
  CONFIDENCE_EMBEDDING,
  CONFIDENCE_CLUSTER,
  GENERIC_FLOOR_DIVISOR,
  EMBEDDING_TOP_K,
  HORIZON_DAYS,
  POS_DECAY_MIN,
  POS_DECAY_PIVOT,
  HEADLINE_EMBED_CACHE_SIZE,
} from './constants.mjs';

// ── Per-process LRU for embedded headlines ─────────────────────────
// Avoids re-embedding the same headline across multiple slot calls in
// the same Node process (spec § 5.7).
const headlineEmbedCache = new Map();

function lruGet(key) {
  if (!headlineEmbedCache.has(key)) return null;
  const value = headlineEmbedCache.get(key);
  // Move to end (most-recently-used).
  headlineEmbedCache.delete(key);
  headlineEmbedCache.set(key, value);
  return value;
}

function lruSet(key, value) {
  if (headlineEmbedCache.has(key)) headlineEmbedCache.delete(key);
  headlineEmbedCache.set(key, value);
  while (headlineEmbedCache.size > HEADLINE_EMBED_CACHE_SIZE) {
    const oldest = headlineEmbedCache.keys().next().value;
    headlineEmbedCache.delete(oldest);
  }
}

export function __resetHeadlineCache() {
  headlineEmbedCache.clear();
}

// ── GSC bridge (cascade step 2) ────────────────────────────────────

/**
 * Build the search index of GSC queries with their normalized stems.
 * Cached per evidence object (identity-based) to avoid re-stemming on
 * every headline.
 */
const gscIndexCache = new WeakMap();

function buildGscIndex(gscBlock) {
  if (!gscBlock || !gscBlock.queries) return [];
  const cached = gscIndexCache.get(gscBlock);
  if (cached) return cached;
  const entries = [];
  for (const [query, stats] of Object.entries(gscBlock.queries)) {
    if (!stats) continue;
    const lower = String(query).toLowerCase();
    const tokens = lower.split(/\s+/).filter(Boolean);
    entries.push({
      query: lower,
      tokens,
      imp: Number(stats.imp) || 0,
      clicks: Number(stats.clicks) || 0,
      pos: Number(stats.pos) || 100,
      ctr: Number(stats.ctr) || 0,
    });
  }
  gscIndexCache.set(gscBlock, entries);
  return entries;
}

function posDecay(pos) {
  return Math.max(POS_DECAY_MIN, (POS_DECAY_PIVOT - pos) / 10);
}

/**
 * Score a headline via the GSC keyword bridge. Returns the best
 * `predictedSessions` per day across all matched queries, or null when
 * no queries match.
 *
 * @param {{ unigrams: string[], bigrams: string[], trigrams: string[], stems: string[] }} terms
 * @param {object} gscBlock
 * @param {{ windowDays?: number }} [opts]
 * @returns {{ stage: 'gsc', rawScore: number, confidence: number, finalScore: number, matchedQuery: string|null }|null}
 */
export function scoreFromGsc(terms, gscBlock, opts = {}) {
  if (!gscBlock || !gscBlock.queries) return null;
  const index = buildGscIndex(gscBlock);
  if (index.length === 0) return null;
  const windowDays = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : 90;

  // Collect search terms (lowercased) — exact + substring + stem.
  const exactTerms = new Set([
    ...(terms.unigrams || []),
    ...(terms.bigrams || []),
    ...(terms.trigrams || []),
    ...(terms.properNouns || []),
  ]);
  const stemSet = new Set(terms.stems || []);

  let best = null;
  for (const entry of index) {
    let matched = false;
    if (exactTerms.has(entry.query)) {
      matched = true;
    } else {
      for (const term of exactTerms) {
        if (term && entry.query.includes(term)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched && stemSet.size > 0) {
      // Stem-match: any stem matches the prefix of any query token.
      for (const tok of entry.tokens) {
        for (const stem of stemSet) {
          if (stem.length >= 3 && tok.startsWith(stem)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
    if (!matched) continue;

    const predictedDaily = (entry.imp / windowDays) * entry.ctr * posDecay(entry.pos);
    if (!best || predictedDaily > best.predictedDaily) {
      best = { predictedDaily, query: entry.query };
    }
  }

  if (!best || best.predictedDaily <= GSC_MIN_SIGNAL) return null;

  const rawScore = best.predictedDaily * HORIZON_DAYS;
  return {
    stage: 'gsc',
    rawScore,
    confidence: CONFIDENCE_GSC,
    finalScore: rawScore * CONFIDENCE_GSC,
    matchedQuery: best.query,
  };
}

// ── Embedding similarity (cascade step 3) ──────────────────────────

/**
 * Score via embedding similarity against published-article corpus.
 * Async — calls the embedding API for the headline. Cached per-process
 * via the LRU above.
 *
 * @param {string} headline
 * @param {object} evidence
 * @param {{ embedFn?: Function, store?: object, meta?: object }} [opts]
 * @returns {Promise<{ stage:'embedding', rawScore:number, confidence:number, finalScore:number, topK:Array }|null>}
 */
export async function scoreFromEmbedding(headline, evidence, opts = {}) {
  const ga4Pages = evidence?.ga4?.pages || {};
  const embedFn = opts.embedFn || embedOne;

  let queryVec = lruGet(headline);
  if (!queryVec) {
    try {
      queryVec = await embedFn(headline);
    } catch (err) {
      // Network / auth failure — degrade to next stage.
      return null;
    }
    if (!queryVec || !(queryVec instanceof Float32Array) || queryVec.length === 0) return null;
    lruSet(headline, queryVec);
  }

  const topK = findTopK(queryVec, { store: opts.store, meta: opts.meta, k: EMBEDDING_TOP_K });
  if (!topK || topK.length === 0) return null;
  if (topK[0].cosine < EMBEDDING_MIN_COSINE) return null;

  // Quality-weighted prediction: sum(sessions_i * cosine_i) / sum(cosine_i).
  let weightedSum = 0;
  let weightTotal = 0;
  for (const hit of topK) {
    if (!hit.slug) continue;
    const sessions = lookupSessionsForSlug(hit.slug, ga4Pages);
    if (sessions === null) continue;
    weightedSum += sessions * hit.cosine;
    weightTotal += hit.cosine;
  }
  if (weightTotal <= 0) return null;
  const predictedSessions = weightedSum / weightTotal;
  const cosineTop1 = topK[0].cosine;
  const rawScore = predictedSessions * cosineTop1;

  return {
    stage: 'embedding',
    rawScore,
    confidence: CONFIDENCE_EMBEDDING,
    finalScore: rawScore * CONFIDENCE_EMBEDDING,
    topK: topK.map((t) => ({ slug: t.slug, cosine: t.cosine })),
  };
}

function lookupSessionsForSlug(slug, ga4Pages) {
  if (!slug || !ga4Pages) return null;
  const candidates = [
    `/articoli-frontaliere/${slug}/`,
    `/articoli-frontaliere/${slug}`,
    `/${slug}/`,
    `/${slug}`,
  ];
  for (const path of candidates) {
    const entry = ga4Pages[path];
    if (entry && Number.isFinite(Number(entry.sessions))) return Number(entry.sessions);
  }
  return null;
}

// ── Cluster fallback (cascade step 4) ──────────────────────────────

/**
 * Final fallback — cluster-median prediction with confidence 0.3.
 * Generic cluster is divided by GENERIC_FLOOR_DIVISOR before applying
 * the confidence multiplier.
 *
 * @param {string} headline
 * @param {object} clusterStats
 * @returns {{ stage:'cluster', rawScore:number, confidence:number, finalScore:number, cluster:string }}
 */
export function scoreFromCluster(headline, clusterStats) {
  const stats = clusterStats || {};
  const cluster = classifyByRegex(String(headline || ''));
  const entry = stats[cluster];
  let p50;
  if (entry && Number.isFinite(Number(entry.p50))) {
    p50 = Number(entry.p50);
  } else {
    const fallback = stats.global || stats.generic;
    p50 = fallback && Number.isFinite(Number(fallback.p50)) ? Number(fallback.p50) / GENERIC_FLOOR_DIVISOR : 0;
  }

  let rawScore;
  if (cluster === 'generic') {
    rawScore = p50 / GENERIC_FLOOR_DIVISOR;
  } else {
    rawScore = p50;
  }

  return {
    stage: 'cluster',
    rawScore,
    confidence: CONFIDENCE_CLUSTER,
    finalScore: rawScore * CONFIDENCE_CLUSTER,
    cluster,
  };
}

// ── Cascade orchestration ──────────────────────────────────────────

/**
 * Run the cascade. Stops at the first non-null stage.
 *
 * @param {string} headline
 * @param {object} evidence — parsed data/evidence-index.json contents
 * @param {{ embedFn?: Function, store?: object, meta?: object, windowDays?: number }} [opts]
 * @returns {Promise<{ stage: 'gsc'|'embedding'|'cluster', rawScore: number, confidence: number, finalScore: number }>}
 */
export async function cascadedScore(headline, evidence, opts = {}) {
  const safeEvidence = evidence || {};
  const terms = extractTerms(headline);

  // Step 1: GSC bridge.
  const gsc = scoreFromGsc(terms, safeEvidence.gsc, {
    windowDays: safeEvidence.windowDays,
  });
  if (gsc) return gsc;

  // Step 2: Embedding similarity.
  const emb = await scoreFromEmbedding(headline, safeEvidence, opts);
  if (emb) return emb;

  // Step 3: Cluster fallback (always returns a value).
  return scoreFromCluster(headline, safeEvidence.clusterStats);
}

// Test seams.
export const __internals = { lookupSessionsForSlug, buildGscIndex };
