// Local semantic guard for machine-translation writes.
//
// The judge deliberately has no side effects: it compares a source text with
// one finalized candidate and returns a verdict.  The default embedder is the
// repository's local multilingual-e5-small client; callers can inject an
// embedder in tests without loading model weights or contacting a provider.

import { embedBatch } from './evidence/embeddingClient.mjs';

export const LOCAL_MT_SEMANTIC_JUDGE_VERSION = 'local-mt-semantic-v1';

// This is a conservative bootstrap value.  #9676 owns calibration against the
// labelled inversion/loss corpus; keeping it exported makes that follow-up a
// one-constant change rather than a hidden policy fork.
export const DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD = 0.62;

const DEFAULT_CACHE_MAX = 1024;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asRows(output) {
  return typeof output?.tolist === 'function' ? output.tolist() : output;
}

function validVector(value) {
  if (!value || typeof value.length !== 'number' || value.length === 0) return false;
  for (const component of value) {
    if (!Number.isFinite(Number(component))) return false;
  }
  return true;
}

/**
 * Cosine similarity for two embedding vectors.
 *
 * Invalid or zero vectors return null instead of a fabricated score.  A
 * missing score is a hard rejection at the write boundary.
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
  const score = dot / denominator;
  return Number.isFinite(score) ? score : null;
}

function normalizedThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold >= -1 && threshold <= 1
    ? threshold
    : DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD;
}

function unavailable(reason, threshold) {
  return {
    accepted: false,
    score: null,
    threshold,
    reason,
  };
}

/**
 * Create a local semantic judge with a bounded per-process vector cache.
 *
 * `embed` follows the embeddingClient contract: it receives `{ inputs,
 * prefix }` and returns one vector per input.  It is intentionally injectable
 * so unit tests never download a model or make a network call.
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
    const key = cleanText(text);
    const cached = vectors.get(key);
    if (cached) return cached;

    const pending = Promise.resolve()
      .then(() => embed({ inputs: [key], prefix: 'passage' }))
      .then(asRows)
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length !== 1 || !validVector(rows[0])) {
          throw new Error('semantic embedder returned no valid vector');
        }
        return rows[0];
      });
    vectors.set(key, pending);
    if (vectors.size > maxEntries) vectors.delete(vectors.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      // A transient model failure must not poison the cache for the next run.
      vectors.delete(key);
      throw error;
    }
  }

  return async function judge({ sourceText, candidateText } = {}) {
    const source = cleanText(sourceText);
    const candidate = cleanText(candidateText);
    if (!source || !candidate) return unavailable('missing-text', minScore);

    try {
      const [sourceVector, candidateVector] = await Promise.all([
        vectorFor(source),
        vectorFor(candidate),
      ]);
      const score = cosineSimilarity(sourceVector, candidateVector);
      if (score === null) return unavailable('score-missing', minScore);
      const accepted = score >= minScore;
      return {
        accepted,
        score,
        threshold: minScore,
        reason: accepted ? 'semantic-match' : 'semantic-mismatch',
      };
    } catch {
      return unavailable('embedding-error', minScore);
    }
  };
}

const defaultJudge = createLocalMtSemanticJudge();

/**
 * Compare a finalized source/candidate pair with the default local model.
 * Never throws: an unavailable model or malformed score is a rejection.
 */
export function judgeLocalMtMeaning(options = {}) {
  return defaultJudge(options);
}
