// Embedding client — LOCAL inference, NO API keys / quota / rate limits.
//
// Runs `multilingual-e5-small` (384-dim, IT/EN/DE/FR) via @huggingface/transformers
// (onnxruntime) directly on the CI runner. This REPLACED the Mistral → Cohere →
// Gemini API chain: every free-tier key had died/exhausted (Mistral 401, Cohere
// trial 1000/month spent, Gemini free 1000/day < the ~2700-article corpus), so a
// full re-embed was impossible and the embedding store froze (→ P1
// B.6.embedding-store-outdated → "Quality alerts" main-red). Local inference
// embeds the whole corpus in one run, deterministically, free forever.
//
// The model weights download once from the public HuggingFace CDN (no key) and
// are cached under `.cache/transformers` (env.cacheDir below; CI-cacheable).

import { EMBEDDING_DIM, EMBEDDING_MODEL } from './constants.mjs';

const NO_PROVIDER_MSG = 'local embedding model unavailable';

/**
 * L2-normalize a vector in place and return it. The pipeline already returns
 * normalized vectors (`normalize: true`); this is a defensive belt so any future
 * pooling/option change can't silently emit non-unit vectors into the store.
 */
function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

// Lazy singleton: the model loads once per process. Injectable for tests
// (setEmbedderForTests) so unit tests never download/run the real model.
let _extractor = null;
let _extractorOverride = null;

/** Test seam: inject a fake feature-extraction callable; pass null to reset. */
export function setEmbedderForTests(fn) {
  _extractorOverride = fn;
  _extractor = null;
}

async function getExtractor() {
  if (_extractorOverride) return _extractorOverride;
  if (!_extractor) {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Cache model weights in the repo (.cache/transformers) instead of
    // node_modules so CI can persist them across runs (actions/cache).
    env.cacheDir = process.env.TRANSFORMERS_CACHE || '.cache/transformers';
    // dtype pinned for reproducibility: the committed store is built with this
    // exact dtype so daily incremental additions stay in one consistent vector
    // space (model id alone doesn't distinguish dtype). fp32 (~470MB) is used
    // because it's what the committed store was generated with; switching to
    // 'q8' (~110MB, 4× smaller CI cache, negligible quality loss) is a safe
    // follow-up but requires regenerating the committed store with q8 in the
    // same change so the spaces match.
    _extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'fp32' });
  }
  return _extractor;
}

// Model id that produced the most recent successful embedding (always the local
// model). The incremental build reads this to detect provider/model drift vs the
// persisted store (meta.model) and force a one-time full re-embed when it
// changes — exactly what happened switching mistral-embed → e5.
let _lastUsedModel = null;
export function lastUsedEmbeddingModel() {
  return _lastUsedModel;
}

/**
 * Embed a batch of strings locally. Returns one unit-norm Float32Array(384) per
 * input, in order. No network, no key, no batch-size cap (CPU-bound only).
 *
 * @param {object} options
 * @param {string[]} options.inputs
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch({ inputs } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const extractor = await getExtractor();
  // e5 models expect a task prefix. The store and query side both embed article
  // text and we compare article↔article (dedup/clustering) + article↔store
  // (findTopK), a symmetric retrieval use, so both sides use the "passage:"
  // prefix consistently (a query/passage split would only matter for asymmetric
  // short-query search, which this isn't).
  const prefixed = inputs.map((t) => `passage: ${String(t ?? '')}`);
  const out = await extractor(prefixed, { pooling: 'mean', normalize: true });
  const rows = typeof out?.tolist === 'function' ? out.tolist() : out;
  if (!Array.isArray(rows) || rows.length !== inputs.length) {
    throw new Error(`local embedder returned ${rows?.length} vectors for ${inputs.length} inputs`);
  }
  const vecs = rows.map((v) => l2normalize(Float32Array.from(v)));
  for (const v of vecs) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`local embedding dim=${v.length} expected ${EMBEDDING_DIM}`);
    }
  }
  _lastUsedModel = EMBEDDING_MODEL;
  return vecs;
}

/** Convenience wrapper for a single input. */
export async function embedOne(text, options = {}) {
  const [vec] = await embedBatch({ inputs: [text], ...options });
  return vec;
}

/**
 * Backwards-compat shim: the API-chain era returned the first keyed provider (or
 * null) so callers could graceful-skip when no key was set. The local model is
 * always available, so a provider is always "selectable". `build-article-embeddings`
 * uses this to decide whether to attempt embedding at all.
 * @returns {{id:string, model:string, dim:number}}
 */
export function selectProvider() {
  return { id: 'local', model: EMBEDDING_MODEL, dim: EMBEDDING_DIM };
}

export { NO_PROVIDER_MSG };
