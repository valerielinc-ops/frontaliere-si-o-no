// Embedding client — multi-provider chain.
//
// Reuses the centralized AI key surface already in Firebase Remote Config
// + scripts/lib/ai-models.mjs. Chain order:
//   1. Mistral (`mistral-embed`, 1024-dim, EU-hosted)
//   2. Cohere (`embed-multilingual-v3.0`, 1024-dim, multilingual)
// Both share dim 1024 so the binary store format is provider-agnostic
// across the chain.
//
// If both keys are missing, embedBatch throws a typed error with a stable
// message — build-article-embeddings.mjs catches it and graceful-skips.
//
// Runtime fallback: if the first keyed provider FAILS at request time (e.g.
// Mistral returns 401 because its key was revoked, or 429/5xx), embedBatch
// falls through to the next keyed provider in the chain instead of throwing.
// A dead Mistral key must not take down the embeddings build when a working
// Cohere key is present (the documented chain). Only when EVERY keyed provider
// fails do we throw the aggregated error.

import { EMBEDDING_DIM, EMBEDDING_PROVIDERS } from './constants.mjs';

const NO_PROVIDER_MSG = 'no embedding provider configured (set MISTRAL_API_KEY or COHERE_API_KEY)';

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
export async function embedBatch({ inputs, fetchImpl = fetch } = {}) {
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
