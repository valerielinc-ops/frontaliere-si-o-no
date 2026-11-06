// scripts/lib/scoring/semanticDedup.mjs
//
// Semantic near-duplicate gate for the article publish pipeline.
//
// The lexical Jaccard signals in create-article.mjs (`checkForDuplicates`)
// miss articles that re-tell the SAME story with different vocabulary. Real
// case (2026-05-29): "Aumento salari Svizzera 2024: +1.5-2% ma solo per
// specialisti" vs the already-published "Aumenti salariali Ticino fino al 2%
// nel 2025" share ~0 title tokens (aumento≠aumenti, salari≠salariali,
// svizzera≠ticino, 2024≠2025) so every Jaccard gate reads ~0 — yet they sit
// at cosine 0.876, i.e. the same article.
//
// This gate embeds the new title+excerpt in the SAME text format the
// published corpus uses (build-article-embeddings.mjs `articleText`:
// `${title}\n\n${excerpt}` sliced to 4000 chars) and rejects when the nearest
// published neighbour is at/above EMBEDDING_NEAR_DUP_COSINE.
//
// Fail-open by design: degrades to a no-op (publish proceeds) when the
// embedding store is absent or the embedding API call fails, so a transient
// outage never blocks the pipeline.

import { embedOne, lastUsedEmbeddingModel } from '../evidence/embeddingClient.mjs';
import { findTopK, loadEmbeddingStore, loadEmbeddingMeta } from './embeddingMatcher.mjs';
import { EMBEDDING_TOP_K, computeAdaptiveNearDupCosine } from './constants.mjs';

/**
 * Build the corpus-comparable embedding text for an article. Must stay in
 * sync with build-article-embeddings.mjs `articleText` or cosines drift.
 *
 * @param {string} title
 * @param {string} excerpt
 * @returns {string}
 */
export function buildDedupText(title, excerpt) {
  return `${title || ''}\n\n${excerpt || ''}`.slice(0, 4000);
}

/**
 * Reject a candidate article when it is a semantic near-duplicate of an
 * already-published one. Throws on duplicate (consistent with
 * checkForDuplicates), returns the data object otherwise.
 *
 * Dependencies are injectable so the gate is unit-testable without the
 * embedding API or the on-disk store (mirrors cascadedScore's opts shape).
 *
 * @param {object} data — article data; reads data.content.it.{title,excerpt},
 *   data.id, data.slugs?.it / data.slug for self-exclusion.
 * @param {{
 *   embedFn?: (text: string) => Promise<Float32Array>,
 *   store?: object,
 *   meta?: object,
 *   threshold?: number,
 *   k?: number,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<object>} the same data object when not a duplicate
 * @throws {Error} when a published neighbour is at/above the threshold
 */
export async function checkSemanticNearDuplicate(data, opts = {}) {
  const log = opts.log || ((msg) => console.error(msg));
  const k = typeof opts.k === 'number' ? opts.k : EMBEDDING_TOP_K;

  const store = opts.store !== undefined ? opts.store : loadEmbeddingStore();
  if (!store) {
    log('  ⏭️  Dedup semantico saltato (store embedding assente)');
    return data;
  }
  // Explicit opts.threshold (used by unit tests / callers that want a fixed
  // gate) is honoured as-is; otherwise scale with this section's corpus
  // size — see computeAdaptiveNearDupCosine in constants.mjs.
  const threshold = typeof opts.threshold === 'number'
    ? opts.threshold
    : computeAdaptiveNearDupCosine(store.count);

  const title = data?.content?.it?.title || '';
  const excerpt = data?.content?.it?.excerpt || '';
  const text = buildDedupText(title, excerpt);
  if (!text.trim()) return data;

  const embedFn = opts.embedFn || embedOne;
  let vec;
  try {
    vec = await embedFn(text);
  } catch (err) {
    log(`  ⏭️  Dedup semantico saltato (embed fallito: ${err.message})`);
    return data;
  }
  if (!(vec instanceof Float32Array) || vec.length === 0) {
    log('  ⏭️  Dedup semantico saltato (embedding vuoto)');
    return data;
  }

  const meta = opts.meta !== undefined ? opts.meta : loadEmbeddingMeta();
  // Gate cross-provider cosine: the query was embedded by whichever provider
  // actually answered (Mistral or its Cohere fallback). If that model differs
  // from the model the store was built with, findTopK degrades to a clean skip.
  const queryModel = opts.queryModel !== undefined ? opts.queryModel : lastUsedEmbeddingModel();
  const topK = findTopK(vec, { store, meta, k, queryModel });
  if (topK.length === 0 && meta && typeof meta.model === 'string' && queryModel && meta.model !== queryModel) {
    log(`  ⏭️  Dedup semantico saltato (store model '${meta.model}' ≠ provider attivo '${queryModel}' — cosine cross-provider non valida)`);
    return data;
  }

  // The new article isn't in the store yet, but a re-publish could match
  // itself — exclude any neighbour that resolves to this same article.
  const selfSlug = data?.slugs?.it || data?.slug || data?.id;
  const nearest = topK.find((t) => t.slug && t.slug !== selfSlug && t.slug !== data?.id);

  if (nearest && nearest.cosine >= threshold) {
    throw new Error(
      `❌ DUPLICATO SEMANTICO RILEVATO:\n`
      + `   Nuovo:     "${title}" [${data?.id}]\n`
      + `   Esistente: [${nearest.slug}]\n`
      + `   Cosine:    ${nearest.cosine.toFixed(3)} ≥ ${threshold} (near-duplicate)\n`
      + `   Stessa notizia con parole diverse — scegli un argomento distinto o più specifico.`,
    );
  }

  log(
    '  ✅ Nessun duplicato semantico'
    + (nearest ? ` (vicino più simile: ${nearest.slug} @ ${nearest.cosine.toFixed(3)})` : ''),
  );
  return data;
}
