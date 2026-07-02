// tests/scripts/lib/scoring/constants.test.ts
//
// computeAdaptiveNearDupCosine (#3138 follow-up): a fixed near-dup cosine
// ceiling doesn't scale with corpus density — nearest-neighbour cosine
// mechanically rises as a section publishes more articles, regardless of
// whether any given pair is a true duplicate. Measured against the real
// frontaliere store (2728 articles) the fixed 0.86 ceiling flags 91% of the
// corpus's own already-published, legitimately-distinct articles as
// "duplicates of themselves". These tests pin the scaling behaviour.

import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_NEAR_DUP_COSINE,
  EMBEDDING_NEAR_DUP_COSINE_CEILING,
  EMBEDDING_NEAR_DUP_CORPUS_BASELINE,
  computeAdaptiveNearDupCosine,
} from '../../../../scripts/lib/scoring/constants.mjs';

describe('computeAdaptiveNearDupCosine', () => {
  it('returns the unmodified baseline at/below the baseline corpus size', () => {
    expect(computeAdaptiveNearDupCosine(EMBEDDING_NEAR_DUP_CORPUS_BASELINE)).toBeCloseTo(EMBEDDING_NEAR_DUP_COSINE, 6);
    expect(computeAdaptiveNearDupCosine(50)).toBe(EMBEDDING_NEAR_DUP_COSINE);
  });

  it('relaxes upward for a 10x-larger corpus (frontaliere/svizzera ratio today)', () => {
    const relaxed = computeAdaptiveNearDupCosine(EMBEDDING_NEAR_DUP_CORPUS_BASELINE * 10);
    expect(relaxed).toBeGreaterThan(EMBEDDING_NEAR_DUP_COSINE);
    expect(relaxed).toBeLessThan(EMBEDDING_NEAR_DUP_COSINE_CEILING);
    // Frontaliere-scale corpus (2728 vs baseline 300) should land in the
    // 0.93-0.94 band — just above the corpus's own measured p75 self-NN
    // cosine (0.934), giving real headroom without gutting the gate.
    expect(relaxed).toBeGreaterThan(0.93);
    expect(relaxed).toBeLessThanOrEqual(0.94);
  });

  it('never exceeds the ceiling even for a very large corpus', () => {
    expect(computeAdaptiveNearDupCosine(10_000_000)).toBe(EMBEDDING_NEAR_DUP_COSINE_CEILING);
  });

  it('never drops below the baseline for a tiny/new corpus', () => {
    expect(computeAdaptiveNearDupCosine(1)).toBe(EMBEDDING_NEAR_DUP_COSINE);
    expect(computeAdaptiveNearDupCosine(0)).toBe(EMBEDDING_NEAR_DUP_COSINE);
  });

  it('falls back to the baseline for invalid input', () => {
    expect(computeAdaptiveNearDupCosine(NaN)).toBe(EMBEDDING_NEAR_DUP_COSINE);
    expect(computeAdaptiveNearDupCosine(-5)).toBe(EMBEDDING_NEAR_DUP_COSINE);
    expect(computeAdaptiveNearDupCosine(undefined as unknown as number)).toBe(EMBEDDING_NEAR_DUP_COSINE);
  });

  it('is monotonically non-decreasing in corpus size', () => {
    const sizes = [100, 300, 500, 1000, 2728, 5000, 50_000];
    let prev = -1;
    for (const n of sizes) {
      const v = computeAdaptiveNearDupCosine(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
