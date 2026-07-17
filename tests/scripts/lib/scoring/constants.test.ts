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
  EVERGREEN_TITLE_JACCARD,
  EVERGREEN_TITLE_JACCARD_CEILING,
  EVERGREEN_FAMILY_OVERLAP,
  EVERGREEN_FAMILY_OVERLAP_CEILING,
  EVERGREEN_PREFLIGHT_CORPUS_BASELINE,
  computeAdaptiveEvergreenThresholds,
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

  it('never exceeds the effective ceiling (max of hardcoded ceiling and env base) for a very large corpus', () => {
    // When NEAR_DUP_COSINE env is not set (default 0.86 < 0.95 ceiling) the
    // result is exactly the hardcoded ceiling. When an operator sets
    // NEAR_DUP_COSINE > 0.95, the effective ceiling is that override value
    // so the env override is not silently clamped back to 0.95 (#3241 fix).
    const effectiveCeiling = Math.max(EMBEDDING_NEAR_DUP_COSINE_CEILING, EMBEDDING_NEAR_DUP_COSINE);
    expect(computeAdaptiveNearDupCosine(10_000_000)).toBe(effectiveCeiling);
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

// computeAdaptiveEvergreenThresholds (2026-07-17):
// preFlightEvergreenTopicCheck's title-Jaccard and family-token-overlap
// thresholds are checked against the combined frontaliere+svizzera corpus
// (~3.2k articles) and, like the embedding gate above, saturate as that
// corpus grows — a 2026-07-17 run rejected all 219 evergreen fallback
// candidates in one pass, producing zero articles. Same log10 scaling fix.
describe('computeAdaptiveEvergreenThresholds', () => {
  it('returns the unmodified base thresholds at/below the baseline corpus size', () => {
    const atBaseline = computeAdaptiveEvergreenThresholds(EVERGREEN_PREFLIGHT_CORPUS_BASELINE);
    expect(atBaseline.titleJaccard).toBeCloseTo(EVERGREEN_TITLE_JACCARD, 6);
    expect(atBaseline.familyOverlap).toBeCloseTo(EVERGREEN_FAMILY_OVERLAP, 6);

    const belowBaseline = computeAdaptiveEvergreenThresholds(50);
    expect(belowBaseline.titleJaccard).toBe(EVERGREEN_TITLE_JACCARD);
    expect(belowBaseline.familyOverlap).toBe(EVERGREEN_FAMILY_OVERLAP);
  });

  it('relaxes upward for a 10x-larger corpus (matches today\'s combined-corpus scale)', () => {
    const relaxed = computeAdaptiveEvergreenThresholds(EVERGREEN_PREFLIGHT_CORPUS_BASELINE * 10);
    expect(relaxed.titleJaccard).toBeCloseTo(0.8, 6);
    expect(relaxed.familyOverlap).toBeCloseTo(0.58, 6);
    expect(relaxed.titleJaccard).toBeLessThan(EVERGREEN_TITLE_JACCARD_CEILING);
    expect(relaxed.familyOverlap).toBeLessThan(EVERGREEN_FAMILY_OVERLAP_CEILING);
  });

  it('never exceeds the effective ceiling for a very large corpus', () => {
    const huge = computeAdaptiveEvergreenThresholds(10_000_000);
    expect(huge.titleJaccard).toBe(EVERGREEN_TITLE_JACCARD_CEILING);
    expect(huge.familyOverlap).toBe(EVERGREEN_FAMILY_OVERLAP_CEILING);
  });

  it('never drops below the baseline for a tiny/new corpus', () => {
    expect(computeAdaptiveEvergreenThresholds(1).titleJaccard).toBe(EVERGREEN_TITLE_JACCARD);
    expect(computeAdaptiveEvergreenThresholds(0).titleJaccard).toBe(EVERGREEN_TITLE_JACCARD);
  });

  it('falls back to the baseline for invalid input', () => {
    expect(computeAdaptiveEvergreenThresholds(NaN).titleJaccard).toBe(EVERGREEN_TITLE_JACCARD);
    expect(computeAdaptiveEvergreenThresholds(-5).titleJaccard).toBe(EVERGREEN_TITLE_JACCARD);
  });

  it('is monotonically non-decreasing in corpus size', () => {
    const sizes = [100, 300, 500, 1000, 3246, 5000, 50_000];
    let prevTitle = -1;
    let prevFamily = -1;
    for (const n of sizes) {
      const v = computeAdaptiveEvergreenThresholds(n);
      expect(v.titleJaccard).toBeGreaterThanOrEqual(prevTitle);
      expect(v.familyOverlap).toBeGreaterThanOrEqual(prevFamily);
      prevTitle = v.titleJaccard;
      prevFamily = v.familyOverlap;
    }
  });
});
