// tests/scripts/lib/scoring/semanticDedup.test.ts
//
// Semantic near-duplicate gate. Covers the real regression: two articles
// that tell the same story with disjoint vocabulary (lexical Jaccard ~0)
// but sit at cosine 0.876 — the lexical gates miss them, this one must not.

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { buildDedupText, checkSemanticNearDuplicate } from '../../../../scripts/lib/scoring/semanticDedup.mjs';

const DIM = 4;

function slugHash(slug: string): string {
  return createHash('sha256').update(slug, 'utf8').digest('hex');
}

/** Build a synthetic store + meta in the shape findTopK consumes. */
function makeStore(entries: Array<{ slug: string; vec: number[] }>) {
  const store = {
    vectors: entries.map((e) => Float32Array.from(e.vec)),
    hashes: entries.map((e) => slugHash(e.slug)),
    dim: DIM,
    count: entries.length,
  };
  const meta = {
    dim: DIM,
    count: entries.length,
    perArticle: Object.fromEntries(
      entries.map((e) => [e.slug, { hash: slugHash(e.slug), byteOffset: 0 }]),
    ),
  };
  return { store, meta };
}

/** A query vector at a known cosine to a unit basis vector. */
function vecAtCosine(cos: number): number[] {
  // cosine to [1,0,0,0] is the first component of the normalized vector.
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  return [cos, sin, 0, 0];
}

const article = (id: string, title: string, excerpt = '') => ({
  id,
  slugs: { it: id },
  content: { it: { title, excerpt } },
});

describe('buildDedupText', () => {
  it('matches the corpus format: title\\n\\nexcerpt, capped at 4000', () => {
    expect(buildDedupText('T', 'E')).toBe('T\n\nE');
    expect(buildDedupText('x'.repeat(5000), 'y').length).toBe(4000);
    expect(buildDedupText('', '')).toBe('\n\n');
  });
});

describe('checkSemanticNearDuplicate', () => {
  const published = [{ slug: 'aumenti-stipendi-ticino-2025', vec: [1, 0, 0, 0] }];

  it('REJECTS a same-story/different-words article at cosine ≥ threshold (the real 0.876 case)', async () => {
    const { store, meta } = makeStore(published);
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(vecAtCosine(0.876)));
    const data = article(
      'salari-specialisti-svizzera-2024',
      'Aumento salari in Svizzera: +1.5-2% nel 2024, ma solo per gli specialisti',
    );
    await expect(
      checkSemanticNearDuplicate(data, { store, meta, embedFn, threshold: 0.86, log: () => {} }),
    ).rejects.toThrow(/DUPLICATO SEMANTICO/);
    expect(embedFn).toHaveBeenCalledOnce();
  });

  it('ALLOWS a related-but-distinct article below threshold', async () => {
    const { store, meta } = makeStore(published);
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(vecAtCosine(0.70)));
    const data = article('stipendi-neolaureati-2026', 'Stipendi neolaureati a confronto');
    const out = await checkSemanticNearDuplicate(data, {
      store, meta, embedFn, threshold: 0.86, log: () => {},
    });
    expect(out).toBe(data);
  });

  it('excludes the article itself (re-publish must not self-trigger)', async () => {
    const { store, meta } = makeStore([{ slug: 'self-article', vec: [1, 0, 0, 0] }]);
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from([1, 0, 0, 0])); // cosine 1.0 to self
    const data = article('self-article', 'Self');
    const out = await checkSemanticNearDuplicate(data, {
      store, meta, embedFn, threshold: 0.86, log: () => {},
    });
    expect(out).toBe(data); // not rejected
  });

  it('fails open when the embedding store is absent', async () => {
    const embedFn = vi.fn();
    const data = article('whatever', 'X');
    const out = await checkSemanticNearDuplicate(data, { store: null, embedFn, log: () => {} });
    expect(out).toBe(data);
    expect(embedFn).not.toHaveBeenCalled(); // short-circuits before embedding
  });

  it('fails open when the embedding API call throws', async () => {
    const { store, meta } = makeStore(published);
    const embedFn = vi.fn().mockRejectedValue(new Error('no provider'));
    const data = article('x', 'Aumento salari Svizzera 2024');
    const out = await checkSemanticNearDuplicate(data, {
      store, meta, embedFn, threshold: 0.86, log: () => {},
    });
    expect(out).toBe(data); // transient outage never blocks publish
  });

  it('fails open when the embedding is empty/invalid', async () => {
    const { store, meta } = makeStore(published);
    const embedFn = vi.fn().mockResolvedValue(new Float32Array(0));
    const data = article('x', 'Aumento salari Svizzera 2024');
    const out = await checkSemanticNearDuplicate(data, {
      store, meta, embedFn, threshold: 0.86, log: () => {},
    });
    expect(out).toBe(data);
  });

  // #3138 follow-up: without an explicit opts.threshold, the gate must scale
  // with THIS store's own count (real per-section corpus size), not the flat
  // 0.86 default — that flat default is what made the gate reject ~100% of
  // frontaliere candidates once its corpus grew past svizzera's by 10x.
  describe('corpus-size-adaptive default threshold (no explicit opts.threshold)', () => {
    it('rejects at cosine 0.876 for a small store (store.count == baseline, unchanged behaviour)', async () => {
      const { store, meta } = makeStore(published);
      store.count = 300; // EMBEDDING_NEAR_DUP_CORPUS_BASELINE
      const embedFn = vi.fn().mockResolvedValue(Float32Array.from(vecAtCosine(0.876)));
      const data = article('x', 'Aumento salari in Svizzera: +1.5-2% nel 2024, ma solo per gli specialisti');
      await expect(
        checkSemanticNearDuplicate(data, { store, meta, embedFn, log: () => {} }),
      ).rejects.toThrow(/DUPLICATO SEMANTICO/);
    });

    it('ALLOWS the same cosine 0.876 pair once the store is frontaliere-scale (large corpus)', async () => {
      const { store, meta } = makeStore(published);
      store.count = 2728; // measured frontaliere store size
      const embedFn = vi.fn().mockResolvedValue(Float32Array.from(vecAtCosine(0.876)));
      const data = article('x', 'Aumento salari in Svizzera: +1.5-2% nel 2024, ma solo per gli specialisti');
      const out = await checkSemanticNearDuplicate(data, { store, meta, embedFn, log: () => {} });
      expect(out).toBe(data);
    });

    it('an explicit opts.threshold always wins over the corpus-size default', async () => {
      const { store, meta } = makeStore(published);
      store.count = 2728;
      const embedFn = vi.fn().mockResolvedValue(Float32Array.from(vecAtCosine(0.876)));
      const data = article('x', 'Aumento salari in Svizzera: +1.5-2% nel 2024, ma solo per gli specialisti');
      await expect(
        checkSemanticNearDuplicate(data, { store, meta, embedFn, threshold: 0.86, log: () => {} }),
      ).rejects.toThrow(/DUPLICATO SEMANTICO/);
    });
  });
});
