import { describe, expect, it } from 'vitest';

import {
  RELATED_SEARCH_CONTEXT_GC_CHECKPOINT,
  isRelatedSearchContextGcEnabled,
  shouldForceRelatedSearchContextGc,
} from '@/build-plugins/shared/relatedSearchContextGc';

describe('related-search context GC checkpoints', () => {
  it('keeps checkpoints enabled by default and allows the build canary to disable them', () => {
    expect(isRelatedSearchContextGcEnabled(undefined)).toBe(true);
    expect(isRelatedSearchContextGcEnabled('1')).toBe(true);
    expect(isRelatedSearchContextGcEnabled('0')).toBe(false);
  });

  it('collects once after the allocations left by preceding SEO page phases', () => {
    expect(shouldForceRelatedSearchContextGc(0)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_CHECKPOINT - 1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_CHECKPOINT)).toBe(true);
    expect(shouldForceRelatedSearchContextGc(RELATED_SEARCH_CONTEXT_GC_CHECKPOINT + 1)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(390_000)).toBe(false);
  });

  it('ignores invalid counters', () => {
    expect(shouldForceRelatedSearchContextGc(-RELATED_SEARCH_CONTEXT_GC_CHECKPOINT)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(1.5)).toBe(false);
    expect(shouldForceRelatedSearchContextGc(Number.NaN)).toBe(false);
  });
});
