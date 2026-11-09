import { describe, expect, it } from 'vitest';

import {
  RELATED_SEARCH_CONTEXT_GC_INTERVAL,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL,
  isRelatedSearchContextGcEnabled,
  shouldForceRelatedSearchContextGc,
} from '@/build-plugins/shared/relatedSearchContextGc';

describe('related-search context GC checkpoints', () => {
  it('keeps checkpoints enabled by default and allows the build canary to disable them', () => {
    expect(isRelatedSearchContextGcEnabled(undefined)).toBe(true);
    expect(isRelatedSearchContextGcEnabled('1')).toBe(true);
    expect(isRelatedSearchContextGcEnabled('0')).toBe(false);
  });

  it('collects in tighter batches during the high-allocation warm-up', () => {
    expect(shouldForceRelatedSearchContextGc(0)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL - 1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL * 2)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS + 1)).toBe(false);
  });

  it('uses wider steady-state batches after the warm-up', () => {
    const firstSteadyCheckpoint = RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS + RELATED_SEARCH_CONTEXT_GC_INTERVAL;
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint - 1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(firstSteadyCheckpoint + RELATED_SEARCH_CONTEXT_GC_INTERVAL)).toBe(true);
  });

  it('ignores invalid counters', () => {
    expect(shouldForceRelatedSearchContextGc(-RELATED_SEARCH_CONTEXT_GC_INTERVAL)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1.5)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(Number.NaN)).toBe(false);
  });
});
