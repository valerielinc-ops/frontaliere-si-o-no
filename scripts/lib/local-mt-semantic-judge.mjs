// Local semantic judge for the Argos mop-up write boundary (#9675).
//
// classifyMopupWrite() in scripts/local-mt-mopup.mjs checks language, length,
// source-copy and protected tokens. None of those predicates reads MEANING: a
// candidate that is well-formed Italian but says something else
// (`Gefängnisseelsorger` → `Prigionieri`) passes all of them. This module
// compares the source text with the finalized candidate and returns a verdict.
//
// Contract:
// - pure with respect to the corpus: it never reads or writes a job;
// - local and free (D7): the default embedder is the repository's
//   multilingual-e5-small client (scripts/lib/evidence/embeddingClient.mjs),
//   no API key, no paid provider; tests inject the embedder;
// - fail-closed: a missing text, a malformed vector, a thrown embedder or a
//   non-finite score is a verdict of `accepted: false` with `score: null`.
//   The caller must then keep the stored value. The judge never throws.
//
// The threshold is a bootstrap value; calibrating it is #9676. Measured once on
// tests/fixtures/local-mt-semantic-cases.json (scores recorded in
// tests/fixtures/local-mt-semantic-e5-scores.json), e5-small source/candidate
// cosine is compressed into 0.82-1.00 and the classes OVERLAP: preserved
// 0.881-0.934, inversion 0.847-0.941, loss 0.821-0.889, and the #9675 report
// pair `Gefängnisseelsorger → Prigionieri` scores 0.900 against 0.912 for the
// correct `Cappellano carcerario`. No threshold separates them, so 0.80 is
// chosen to reject none of the measured correct candidates (lowest 0.836):
// this gate adds the fail-closed boundary and catches gross mismatches.
// Replacing a stored value goes further: ./local-mt-semantic-policy.mjs (#9676)
// adds deterministic meaning guards and a cutoff calibrated on that dataset.
// Filling an empty slot still uses this bootstrap threshold.

import { embedBatch } from './evidence/embeddingClient.mjs';

export const LOCAL_MT_SEMANTIC_JUDGE_VERSION = 'local-mt-semantic-v1';

export const DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD = 0.8;

export const SEMANTIC_VERDICT = Object.freeze({
  ACCEPT: 'accept',
  MISMATCH: 'mismatch',
  UNAVAILABLE: 'unavailable',
});

const DEFAULT_CACHE_MAX = 1024;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asRows(output) {
  return typeof output?.tolist === 'function' ? output.tolist() : output;
}

function validVector(value) {
  if (!value || typeof value.length !== 'number' || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!Number.isFinite(Number(value[i]))) return false;
  }
  return true;
}

function validScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * Cosine similarity of two embedding vectors. Invalid, mismatched or zero
 * vectors return null instead of a fabricated score.
 */
export function cosineSimilarity(a, b) {
  if (!validVector(a) || !validVector(b) || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denominator) || denominator <= Number.EPSILON) return null;
  // Float rounding can push a unit-vector cosine a hair past ±1.
  const score = Math.max(-1, Math.min(1, dot / denominator));
  return Number.isFinite(score) ? score : null;
}

function normalizedThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold >= -1 && threshold <= 1
    ? threshold
    : DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD;
}

/**
 * Reduce any verdict-shaped value to one of three outcomes. This is the single
 * place that decides what a verdict means at the write boundary, so the
 * synchronous classifier, the async path and the tests cannot disagree.
 *
 * Only an explicit `accepted: true` carrying a finite score in [-1, 1] that
 * also clears its own threshold is an accept. A finite score with
 * `accepted: false` is a mismatch. Everything else — undefined, null, a thrown
 * judge, NaN, a score without a verdict — is unavailable.
 */
export function interpretSemanticVerdict(verdict) {
  const score = validScore(verdict?.score) ? verdict.score : null;
  if (score === null) return { outcome: SEMANTIC_VERDICT.UNAVAILABLE, score: null };
  const threshold = verdict?.threshold === undefined
    ? null
    : normalizedThreshold(verdict.threshold);
  if (verdict?.accepted === true && (threshold === null || score >= threshold)) {
    return { outcome: SEMANTIC_VERDICT.ACCEPT, score };
  }
  if (verdict?.accepted === false || verdict?.accepted === true) {
    return { outcome: SEMANTIC_VERDICT.MISMATCH, score };
  }
  return { outcome: SEMANTIC_VERDICT.UNAVAILABLE, score: null };
}

function unavailable(reason, threshold) {
  return { accepted: false, score: null, threshold, reason };
}

/**
 * Create a semantic judge with a bounded per-process vector cache.
 *
 * `embed` follows the embeddingClient contract: it receives `{ inputs, prefix }`
 * and returns one vector per input. Both sides use the `passage` prefix: the
 * comparison is symmetric (source text vs its translation), not a retrieval.
 */
export function createLocalMtSemanticJudge({
  embed = embedBatch,
  threshold = DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD,
  cacheMax = DEFAULT_CACHE_MAX,
} = {}) {
  const minScore = normalizedThreshold(threshold);
  const maxEntries = Math.max(1, Number(cacheMax) || DEFAULT_CACHE_MAX);
  const vectors = new Map();

  async function vectorFor(text) {
    const cached = vectors.get(text);
    if (cached) return cached;

    const pending = Promise.resolve()
      .then(() => embed({ inputs: [text], prefix: 'passage' }))
      .then(asRows)
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length !== 1 || !validVector(rows[0])) {
          throw new Error('semantic embedder returned no valid vector');
        }
        return rows[0];
      });
    vectors.set(text, pending);
    if (vectors.size > maxEntries) vectors.delete(vectors.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      // A transient model failure must not poison the cache for later slots.
      vectors.delete(text);
      throw error;
    }
  }

  return async function judge({ sourceText, candidateText } = {}) {
    const source = cleanText(sourceText);
    const candidate = cleanText(candidateText);
    if (!source || !candidate) return unavailable('missing-text', minScore);

    let score;
    try {
      const [sourceVector, candidateVector] = await Promise.all([
        vectorFor(source),
        vectorFor(candidate),
      ]);
      score = cosineSimilarity(sourceVector, candidateVector);
    } catch {
      return unavailable('embedding-error', minScore);
    }
    if (score === null) return unavailable('score-missing', minScore);
    const accepted = score >= minScore;
    return {
      accepted,
      score,
      threshold: minScore,
      reason: accepted ? 'semantic-match' : 'semantic-mismatch',
    };
  };
}

let defaultJudge = null;

/**
 * Compare a finalized source/candidate pair with the default local model.
 * Never throws: an unavailable model or a malformed score is a rejection.
 * The judge (and its vector cache) is created on first use, so importing this
 * module costs nothing.
 */
export function judgeLocalMtMeaning(options = {}) {
  if (!defaultJudge) defaultJudge = createLocalMtSemanticJudge();
  return defaultJudge(options);
}
