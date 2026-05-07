// Embedding client — single provider, hardcoded.
//
// Decision (Phase 1, 2026-05-07): use OpenAI's `/v1/embeddings` endpoint
// directly. OpenRouter's catalog does NOT carry `text-embedding-3-small`
// reliably (it indexes chat-completion models almost exclusively), and
// none of the other providers in `scripts/lib/ai-models.mjs` expose an
// embeddings endpoint compatible with the spec'd 1536-dim model. Cost is
// $0.02/1M tokens — see Section 12.1 of the design doc, ~$0.50/wk full
// refresh, ~$0.05/day incremental.
//
// Auth: OPENAI_API_KEY env var. Hard fail if missing — embeddings are
// optional in the ETL (only built when the `--embeddings` flag is passed),
// so the caller decides whether to require this.

import { EMBEDDING_DIM, EMBEDDING_MODEL } from './constants.mjs';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * Compute embeddings for a batch of input strings.
 * @param {object} options
 * @param {string[]} options.inputs - text inputs (max ~100 per request)
 * @param {string} [options.model=EMBEDDING_MODEL]
 * @param {string} [options.apiKey=process.env.OPENAI_API_KEY]
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<Float32Array[]>} - one Float32Array(EMBEDDING_DIM) per input
 */
export async function embedBatch({
  inputs,
  model = EMBEDDING_MODEL,
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  if (!apiKey) throw new Error('OPENAI_API_KEY missing — set it to compute embeddings');

  const res = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data?.data || [];
  // OpenAI returns rows in the same order as input — but it also tags each
  // with `index`, which we honour just in case.
  const out = new Array(inputs.length);
  for (const row of rows) {
    const idx = typeof row.index === 'number' ? row.index : out.indexOf(undefined);
    const arr = row.embedding;
    if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIM) {
      throw new Error(`unexpected embedding dim: ${arr?.length} (expected ${EMBEDDING_DIM})`);
    }
    out[idx] = Float32Array.from(arr);
  }
  return out;
}

/**
 * Convenience wrapper for a single input.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedOne(text, options = {}) {
  const [vec] = await embedBatch({ inputs: [text], ...options });
  return vec;
}
