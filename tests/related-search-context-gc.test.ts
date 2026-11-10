import { describe, expect, it } from 'vitest';

import {
  RELATED_SEARCH_CONTEXT_GC_INTERVAL,
  RELATED_SEARCH_CONTEXT_GC_GUARD_HEADROOM_MB,
  RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS,
  RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL,
  createRelatedSearchContextGcCounters,
  decideRelatedSearchContextGc,
  isRelatedSearchContextGcEnabled,
  recordRelatedSearchContextGcCollection,
  recordRelatedSearchContextGcSample,
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

  it('collects when anonymous footprint grows by 512 MiB while heap growth stays below 512 MiB', () => {
    const decision = decideRelatedSearchContextGc(
      10_400 * 1024 * 1024,
      10_000 * 1024 * 1024,
      16_512,
      16_000,
      19_510,
    );

    expect(decision.shouldCollect).toBe(true);
    expect(decision.reason).toContain('anon_growth');
    expect(decision.usedHeapOnlyFallback).toBe(false);
  });

  it('collects near the guard ceiling even when heap and anonymous growth stay below 512 MiB', () => {
    const decision = decideRelatedSearchContextGc(
      10_400 * 1024 * 1024,
      10_000 * 1024 * 1024,
      19_510 - RELATED_SEARCH_CONTEXT_GC_GUARD_HEADROOM_MB,
      17_000,
      19_510,
    );

    expect(decision.shouldCollect).toBe(true);
    expect(decision.reason).toContain('near_guard_ceiling');
  });

  it('skips when heap growth, anonymous growth, and guard headroom are below their thresholds', () => {
    const decision = decideRelatedSearchContextGc(
      10_400 * 1024 * 1024,
      10_000 * 1024 * 1024,
      14_100,
      14_000,
      19_510,
    );

    expect(decision.shouldCollect).toBe(false);
    expect(decision.reason).toContain('below_threshold');
  });

  it('falls back to the heap-only predicate when current anonymous telemetry is invalid', () => {
    const belowHeapThreshold = decideRelatedSearchContextGc(
      10_400 * 1024 * 1024,
      10_000 * 1024 * 1024,
      Number.NaN,
      14_000,
      19_510,
    );
    const atHeapThreshold = decideRelatedSearchContextGc(
      10_512 * 1024 * 1024,
      10_000 * 1024 * 1024,
      null,
      14_000,
      19_510,
    );

    expect(belowHeapThreshold.shouldCollect).toBe(false);
    expect(belowHeapThreshold.usedHeapOnlyFallback).toBe(true);
    expect(belowHeapThreshold.reason).toContain('anon_telemetry_unavailable');
    expect(atHeapThreshold.shouldCollect).toBe(true);
    expect(atHeapThreshold.usedHeapOnlyFallback).toBe(true);
    expect(atHeapThreshold.reason).toContain('heap_growth');
  });

  it('skips the guard-ceiling check when the in-process ceiling is unavailable', () => {
    const decision = decideRelatedSearchContextGc(
      10_400 * 1024 * 1024,
      10_000 * 1024 * 1024,
      18_000,
      17_500,
      null,
    );

    expect(decision.shouldCollect).toBe(false);
    expect(decision.reason).toContain('guard_ceiling_unavailable');
  });

  it('counts scheduled samples separately from successful collections', () => {
    const counters = createRelatedSearchContextGcCounters();

    recordRelatedSearchContextGcSample(counters);
    recordRelatedSearchContextGcSample(counters);
    recordRelatedSearchContextGcCollection(counters);

    expect(counters).toEqual({ samples: 2, collections: 1 });
  });
});
