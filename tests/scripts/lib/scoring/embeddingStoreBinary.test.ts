// tests/scripts/lib/scoring/embeddingStoreBinary.test.ts
//
// End-to-end smoke test of the REAL binary embedding store (dim-1024,
// mistral-embed) that the semantic-dedup gate reads in production. The unit
// tests for findTopK/checkSemanticNearDuplicate use a synthetic dim-4 store
// and never touch the binary read path (`loadEmbeddingStore`/`loadEmbeddingMeta`)
// with a real Float32 payload. This test closes that gap: it parses the
// committed `data/article-embeddings.bin`, takes vectors straight from the
// store, and verifies findTopK self-matches at cosine ~1.0 — proving the
// binary decode, dim handling, cosine math and hash→slug mapping behave the
// same in CI as the synthetic tests assume in production.

import { describe, expect, it } from 'vitest';

import {
  loadEmbeddingStore,
  loadEmbeddingMeta,
  findTopK,
  __resetCache,
} from '../../../../scripts/lib/scoring/embeddingMatcher.mjs';
import { EMBEDDING_DIM } from '../../../../scripts/lib/evidence/constants.mjs';

describe('real binary embedding store (dim-1024 end-to-end)', () => {
  __resetCache();
  const store = loadEmbeddingStore({ force: true });
  const meta = loadEmbeddingMeta({ force: true });

  it('parses the committed binary store with the expected shape', () => {
    expect(store).not.toBeNull();
    expect(meta).not.toBeNull();
    expect(store!.count).toBeGreaterThan(0);
    expect(store!.dim).toBe(EMBEDDING_DIM);
    expect(store!.dim).toBe(meta!.dim);
    expect(store!.count).toBe(meta!.count);
    // Every record is a real Float32 vector of the declared dimensionality.
    expect(store!.vectors[0]).toBeInstanceOf(Float32Array);
    expect(store!.vectors[0].length).toBe(EMBEDDING_DIM);
  });

  it('findTopK self-matches a stored vector at cosine ~1.0 (binary decode + cosine math)', () => {
    // Sample a few records spread across the store, not just index 0, so a
    // mid/tail byte-offset decode bug can't slip through.
    const indices = [0, Math.floor(store!.count / 2), store!.count - 1];
    for (const i of indices) {
      const vec = store!.vectors[i];
      const top = findTopK(vec, { store: store!, meta: meta!, k: 1 });
      expect(top).toHaveLength(1);
      expect(top[0].index).toBe(i);
      expect(top[0].hash).toBe(store!.hashes[i]);
      // A vector compared to itself is cosine 1.0 up to float32 rounding.
      expect(top[0].cosine).toBeGreaterThan(0.9999);
      // Meta resolves the slug-hash back to a real slug (gate's neighbour id).
      expect(typeof top[0].slug).toBe('string');
      expect(top[0].slug!.length).toBeGreaterThan(0);
    }
  });
});
