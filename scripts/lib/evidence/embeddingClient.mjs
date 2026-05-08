// Embedding client — multi-provider chain.
//
// Reuses the centralized AI key surface (Mistral / Cohere) already in
// Firebase Remote Config + scripts/lib/ai-models.mjs. No GitHub secret
// for OpenAI required. Chain order:
//   1. Mistral (`mistral-embed`, 1024-dim, EU-hosted)
//   2. Cohere (`embed-multilingual-v3.0`, 1024-dim, multilingual)
// Both share dim 1024 so the binary store format is provider-agnostic
// as long as the chain stays within these two.
//
// If both keys are missing, embedBatch throws a typed error with a stable
// message — build-article-embeddings.mjs catches it and graceful-skips.

import { EMBEDDING_DIM, EMBEDDING_PROVIDERS } from './constants.mjs';

const NO_PROVIDER_MSG = 'no embedding provider configured (set MISTRAL_API_KEY or COHERE_API_KEY)';

/**
 * Pick the first provider whose API key is in env. Returns null if none.
 * @returns {{id:string, model:string, dim:number, url:string, key:string}|null}
 */
function selectProvider() {
  for (const p of EMBEDDING_PROVIDERS) {
    const key = (process.env[p.keyEnv] || '').trim();
    if (key) return { ...p, key };
  }
  return null;
}

/**
 * Mistral request adapter. Mistral uses OpenAI-compatible /embeddings.
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

  const provider = selectProvider();
  if (!provider) throw new Error(NO_PROVIDER_MSG);

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
  return vectors;
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
