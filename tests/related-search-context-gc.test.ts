import { describe, expect, it } from 'vitest';

import {
  RELATED_SEARCH_CONTEXT_GC_INTERVAL,
  RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL,
  isRelatedSearchContextGcEnabled,
  shouldCollectRelatedSearchContextGarbage,
  shouldForceRelatedSearchContextGc,
} from '@/build-plugins/shared/relatedSearchContextGc';

describe('related-search context GC checkpoints', () => {
  it('keeps checkpoints enabled by default and allows the build canary to disable them', () => {
    expect(isRelatedSearchContextGcEnabled(undefined)).toBe(true);
    expect(isRelatedSearchContextGcEnabled('1')).toBe(true);
    expect(isRelatedSearchContextGcEnabled('0')).toBe(false);
  });

  it('keeps bounded warmup and steady-state collection checkpoints', () => {
    expect(shouldForceRelatedSearchContextGc(0)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL - 1)).toBe(false);
    for (let contexts = RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL; contexts <= RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS; contexts += RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL) {
      expect(shouldForceRelatedSearchContextGc(contexts)).toBe(true);
    }
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS + 1)).toBe(false);
    const firstSteadyCheckpoint = RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS + RELATED_SEARCH_CONTEXT_GC_INTERVAL;
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint - 1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint + RELATED_SEARCH_CONTEXT_GC_INTERVAL)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(390_000)).toBe(true);
  });

  it('ignores invalid counters', () => {
    expect(shouldForceRelatedSearchContextGc(-RELATED_SEARCH_CONTEXT_GC_INTERVAL)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1.5)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(Number.NaN)).toBe(false);
  });

  it('always collects at the first checkpoint, then waits for material heap growth', () => {
    expect(shouldCollectRelatedSearchContextGarbage(12_000, null)).toBe(true);
    expect(shouldCollectRelatedSearchContextGarbage(12_000 * 1024 * 1024, 11_488 * 1024 * 1024)).toBe(true);
    expect(shouldCollectRelatedSearchContextGarbage(
      11_000 * 1024 * 1024 + RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES - 1,
      11_000 * 1024 * 1024,
    )).toBe(false);
    expect(shouldCollectRelatedSearchContextGarbage(
      11_000 * 1024 * 1024 + RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES,
      11_000 * 1024 * 1024,
    )).toBe(true);
    expect(shouldCollectRelatedSearchContextGarbage(Number.NaN, 1)).toBe(false);
    expect(shouldCollectRelatedSearchContextGarbage(1, Number.NaN)).toBe(true);
  });
});
