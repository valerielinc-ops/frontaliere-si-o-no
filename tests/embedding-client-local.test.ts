/**
 * embeddingClient — LOCAL embedder (multilingual-e5-small via onnxruntime, no
 * keys/quota). Replaced the Mistral/Cohere/Gemini API chain after every free-tier
 * key died/exhausted and a ~2700-article re-embed became impossible. These tests
 * use the injectable extractor seam (setEmbedderForTests) so they never download
 * or run the real model.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from '../scripts/lib/evidence/constants.mjs';
import {
  embedBatch,
  embedOne,
  embedQuery,
  lastUsedEmbeddingModel,
  selectProvider,
  setEmbedderForTests,
} from '../scripts/lib/evidence/embeddingClient.mjs';

afterEach(() => setEmbedderForTests(null));

// A fake feature-extraction pipeline: records the inputs it was called with and
// returns a tensor-like object with `.tolist()` of EMBEDDING_DIM vectors.
function fakeExtractor(vecForIndex: (i: number) => number[]) {
  const calls: { inputs: string[]; opts: unknown }[] = [];
  const fn = async (inputs: string[], opts: unknown) => {
    calls.push({ inputs, opts });
    return { tolist: () => inputs.map((_, i) => vecForIndex(i)) };
  };
  return Object.assign(fn, { calls });
}

const unitVec = () => Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0));

describe('embeddingClient — local provider', () => {
  it('selectProvider is always available (no key) and reports the local model', () => {
    const p = selectProvider();
    expect(p).toMatchObject({ id: 'local', model: EMBEDDING_MODEL, dim: EMBEDDING_DIM });
  });

  it('embeds with the e5 "passage:" prefix, mean-pool + normalize, returns 384-dim', async () => {
    const ex = fakeExtractor(() => Array(EMBEDDING_DIM).fill(3)); // non-unit → must normalize
    setEmbedderForTests(ex);
    const out = await embedBatch({ inputs: ['ciao', 'mondo'] });

    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0].inputs).toEqual(['passage: ciao', 'passage: mondo']);
    expect(ex.calls[0].opts).toMatchObject({ pooling: 'mean', normalize: true });

    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.length).toBe(EMBEDDING_DIM);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
    expect(lastUsedEmbeddingModel()).toBe(EMBEDDING_MODEL);
  });

  it('embedOne returns a single 384-dim vector', async () => {
    setEmbedderForTests(fakeExtractor(unitVec));
    const v = await embedOne('frontaliere');
    expect(v.length).toBe(EMBEDDING_DIM);
  });

  it('embedQuery uses "query:" prefix for asymmetric retrieval (headline → passage store)', async () => {
    const ex = fakeExtractor(unitVec);
    setEmbedderForTests(ex);
    const v = await embedQuery('Aumento salari Svizzera 2024');
    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0].inputs).toEqual(['query: Aumento salari Svizzera 2024']);
    expect(v.length).toBe(EMBEDDING_DIM);
  });

  it('empty input returns [] without touching the model', async () => {
    const ex = fakeExtractor(unitVec);
    setEmbedderForTests(ex);
    expect(await embedBatch({ inputs: [] })).toEqual([]);
    expect(ex.calls).toHaveLength(0);
  });

  it('rejects a wrong-dim vector (store consistency guard)', async () => {
    setEmbedderForTests(fakeExtractor(() => Array(EMBEDDING_DIM - 1).fill(0.1)));
    await expect(embedBatch({ inputs: ['x'] })).rejects.toThrow(/dim=.*expected/);
  });

  it('rejects a vector-count mismatch', async () => {
    const ex = async () => ({ tolist: () => [unitVec()] }); // 1 vec for 2 inputs
    setEmbedderForTests(ex);
    await expect(embedBatch({ inputs: ['a', 'b'] })).rejects.toThrow(/returned 1 vectors for 2/);
  });
});
