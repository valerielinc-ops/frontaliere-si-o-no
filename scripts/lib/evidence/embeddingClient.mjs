// Embedding client — multi-provider chain.
//
// Reuses the centralized AI key surface already in Firebase Remote Config
// + scripts/lib/ai-models.mjs. Chain order:
//   1. Mistral (`mistral-embed`, 1024-dim, EU-hosted)
//   2. Cohere (`embed-multilingual-v3.0`, 1024-dim, multilingual)
//   3. Gemini (`gemini-embedding-001`, outputDimensionality=1024, L2-normalized)
// All emit dim 1024 so the binary store format is provider-agnostic across the
// chain. Gemini is the rescue tail (added 2026-06-17): when Mistral 401'd and
// Cohere was unset the chain exhausted and the embeddings build froze the store
// → P1 `B.6.embedding-store-outdated` alert reddened the Quality-alerts monitor.
// GEMINI_API_KEY is the project's live free key, so it keeps embeddings flowing.
//
// If NO key is present, embedBatch throws a typed error with a stable message —
// build-article-embeddings.mjs catches it and graceful-skips.
//
// Runtime fallback: if the first keyed provider FAILS at request time (e.g.
// Mistral returns 401 because its key was revoked, or 429/5xx), embedBatch
// falls through to the next keyed provider in the chain instead of throwing.
// A dead Mistral key must not take down the embeddings build when a working
// Cohere key is present (the documented chain). Only when EVERY keyed provider
// fails do we throw the aggregated error.

import { EMBEDDING_DIM, EMBEDDING_PROVIDERS } from './constants.mjs';

const NO_PROVIDER_MSG = 'no embedding provider configured (set MISTRAL_API_KEY, COHERE_API_KEY or GEMINI_API_KEY)';

/**
 * L2-normalize a vector in place and return it. Gemini's MRL-truncated
 * embeddings (outputDimensionality < 3072) are NOT unit-norm from the API, so
 * the caller must normalize for cosine/dot to be meaningful (Google guidance).
 * No-op-safe on a zero vector.
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

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Extract the retry-after delay (ms) from a Gemini 429 body. Honors both the
 * structured RetryInfo (`"retryDelay": "51s"`) and the prose form
 * (`Please retry in 51.83s`). Falls back to 60s (the free-tier window is
 * per-minute), clamped to [1s, 90s] so a malformed/huge value can't hang a run.
 */
export function parseGeminiRetryMs(bodyText = '') {
  const m =
    /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(bodyText) ||
    /retry in ([\d.]+)\s*s/i.exec(bodyText);
  const sec = m ? parseFloat(m[1]) : 60;
  const ms = Math.round((Number.isFinite(sec) ? sec : 60) * 1000) + 250; // +250ms cushion
  return Math.min(Math.max(ms, 1000), 90_000);
}

/**
 * All providers whose API key is in env, in chain order. Empty if none.
 * @returns {Array<{id:string, model:string, dim:number, url:string, key:string}>}
 */
function selectProviders() {
  const out = [];
  for (const p of EMBEDDING_PROVIDERS) {
    const key = (process.env[p.keyEnv] || '').trim();
    if (key) out.push({ ...p, key });
  }
  return out;
}

/**
 * Pick the first provider whose API key is in env. Returns null if none.
 * Kept for backward compat (tests/debugging import this).
 * @returns {{id:string, model:string, dim:number, url:string, key:string}|null}
 */
function selectProvider() {
  return selectProviders()[0] || null;
}

/**
 * Mistral request adapter. POST /v1/embeddings with { model, input }.
 */
async function callMistral({ provider, inputs, fetchImpl }) {
  const res = await fetchImpl(provider.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: provider.model, input: inputs }),
  });
  if (!res.ok) throw new Error(`mistral embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data?.data || [];
  return rows.map((r) => Float32Array.from(r.embedding));
}

/**
 * Cohere request adapter. Cohere v2/embed uses a different request shape:
 * { texts, model, input_type, embedding_types }.
 * Returns embeddings nested under `embeddings.float`.
 */
async function callCohere({ provider, inputs, fetchImpl }) {
  const res = await fetchImpl(provider.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      texts: inputs,
      input_type: 'search_document',
      embedding_types: ['float'],
    }),
  });
  if (!res.ok) throw new Error(`cohere embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data?.embeddings?.float || [];
  return rows.map((arr) => Float32Array.from(arr));
}

/**
 * Gemini request adapter. `gemini-embedding-001:batchEmbedContents` takes
 * `{ requests: [{ model, content:{parts:[{text}]}, outputDimensionality, taskType }] }`
 * with the key in the `x-goog-api-key` header. Embeddings come back in order
 * under `embeddings[].values`. outputDimensionality=1024 (MRL) matches the store;
 * truncated vectors are L2-normalized here (not unit-norm from the API). Inputs
 * are split into ≤GEMINI_MAX_BATCH sub-batches (free-tier per-minute cap) and
 * concatenated in order; each sub-batch retries on 429.
 */
// Gemini free tier is 100 embed requests / MINUTE / model and each input in a
// batchEmbedContents call counts as one request, so a single 100-input call
// consumes (or exceeds) the whole window and 429s — observed even on a fresh
// minute during the one-time full re-embed (~2700 articles). Sub-batch well
// under the cap so each call fits comfortably; the per-chunk 429-retry then
// self-throttles total throughput to ~the per-minute budget. Incremental runs
// (tens of new articles/day) finish in a chunk or two without ever waiting.
const GEMINI_MAX_BATCH = 16;

/** One gemini batchEmbedContents call (≤GEMINI_MAX_BATCH inputs) with 429-retry. */
async function geminiEmbedChunk({ provider, inputs, fetchImpl, sleepImpl, maxRetries, model }) {
  const body = JSON.stringify({
    requests: inputs.map((text) => ({
      model,
      content: { parts: [{ text }] },
      outputDimensionality: provider.dim,
      taskType: 'RETRIEVAL_DOCUMENT',
    })),
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { 'x-goog-api-key': provider.key, 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const rows = data?.embeddings || [];
      return rows.map((r) => l2normalize(Float32Array.from(r.values || [])));
    }
    const text = await res.text();
    if (res.status === 429 && attempt < maxRetries) {
      const waitMs = parseGeminiRetryMs(text);
      console.error(`gemini embeddings 429 (rate limit) — waiting ${Math.round(waitMs / 1000)}s then retrying chunk (attempt ${attempt + 1}/${maxRetries})`);
      await sleepImpl(waitMs);
      continue;
    }
    throw new Error(`gemini embeddings ${res.status}: ${text}`);
  }
}

async function callGemini({ provider, inputs, fetchImpl, sleepImpl = realSleep, maxRetries = 8 }) {
  const model = `models/${provider.model}`;
  const out = [];
  for (let i = 0; i < inputs.length; i += GEMINI_MAX_BATCH) {
    const chunk = inputs.slice(i, i + GEMINI_MAX_BATCH);
    const vecs = await geminiEmbedChunk({ provider, inputs: chunk, fetchImpl, sleepImpl, maxRetries, model });
    out.push(...vecs);
  }
  return out;
}

/**
 * Compute embeddings for a batch of input strings.
 * Tries the configured provider chain; first provider with a key in env wins.
 *
 * @param {object} options
 * @param {string[]} options.inputs - text inputs (max ~100 per request)
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<Float32Array[]>} - one Float32Array(EMBEDDING_DIM) per input
 * @throws {Error} when no provider key is configured (caller graceful-skips)
 * @throws {Error} when provider returns wrong shape or HTTP error
 */
// Model id of the provider that produced the most recent successful embedding.
// CRITICAL for store consistency: mistral-embed and embed-multilingual-v3.0
// share dim=1024 but are DIFFERENT vector spaces — cosine across them is
// meaningless. Consumers (findTopK, semanticDedup, cascadedScore, the
// incremental embeddings build) must compare query↔store ONLY when both come
// from the same model. Reading the *first keyed provider* is NOT sufficient
// (the Mistral key can be present but revoked → embeds actually come from the
// Cohere fallback), so we record the model that ACTUALLY answered.
let _lastUsedModel = null;

/**
 * Model id (e.g. 'mistral-embed' / 'embed-multilingual-v3.0') of the provider
 * that produced the most recent successful embedBatch/embedOne call, or null if
 * none has succeeded yet in this process. Use to gate cross-provider cosine.
 * @returns {string|null}
 */
export function lastUsedEmbeddingModel() {
  return _lastUsedModel;
}

export async function embedBatch({ inputs, fetchImpl = fetch, sleepImpl } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];

  const providers = selectProviders();
  if (providers.length === 0) throw new Error(NO_PROVIDER_MSG);

  const failures = [];
  for (const provider of providers) {
    try {
      let vectors;
      if (provider.id === 'mistral') {
        vectors = await callMistral({ provider, inputs, fetchImpl });
      } else if (provider.id === 'cohere') {
        vectors = await callCohere({ provider, inputs, fetchImpl });
      } else if (provider.id === 'gemini') {
        vectors = await callGemini({ provider, inputs, fetchImpl, ...(sleepImpl ? { sleepImpl } : {}) });
      } else {
        throw new Error(`unknown embedding provider: ${provider.id}`);
      }

      if (vectors.length !== inputs.length) {
        throw new Error(`provider ${provider.id} returned ${vectors.length} vectors for ${inputs.length} inputs`);
      }
      for (const v of vectors) {
        if (v.length !== EMBEDDING_DIM) {
          throw new Error(`provider ${provider.id} returned dim=${v.length} expected ${EMBEDDING_DIM}`);
        }
      }
      if (failures.length > 0) {
        // We recovered via a fallback provider — surface which one for diagnosis.
        console.error(`embedBatch: recovered on '${provider.id}' after ${failures.length} provider failure(s): ${failures.join(' | ')}`);
      }
      _lastUsedModel = provider.model;
      return vectors;
    } catch (err) {
      failures.push(`${provider.id}: ${err?.message || err}`);
      // Try the next keyed provider in the chain before giving up.
    }
  }

  throw new Error(`all embedding providers failed — ${failures.join(' | ')}`);
}

/**
 * Convenience wrapper for a single input.
 */
export async function embedOne(text, options = {}) {
  const [vec] = await embedBatch({ inputs: [text], ...options });
  return vec;
}

// Exported for tests + debugging.
export { selectProvider, NO_PROVIDER_MSG };
