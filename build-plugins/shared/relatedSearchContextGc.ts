export const RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS = 20_000;
export const RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL = 2_500;
export const RELATED_SEARCH_CONTEXT_GC_INTERVAL = 10_000;
export const RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES = 512 * 1024 * 1024;
export const RELATED_SEARCH_CONTEXT_GC_GUARD_HEADROOM_MB = 2_048;

/** Disable only the periodic matching-phase checkpoints for a build canary. */
export function isRelatedSearchContextGcEnabled(value: string | undefined): boolean {
  return value !== '0';
}

/**
 * Keep short-lived matcher allocations from accumulating through the full
 * 395k-candidate pass. The first 20k contexts use tighter checkpoints because
 * production profiles show most transient heap growth in that warm-up window.
 */
export function shouldForceRelatedSearchContextGc(processedContexts: number): boolean {
  if (!Number.isSafeInteger(processedContexts) || processedContexts <= 0) return false;
  if (processedContexts <= RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS) {
    return processedContexts % RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL === 0;
  }
  return (processedContexts - RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS)
    % RELATED_SEARCH_CONTEXT_GC_INTERVAL === 0;
}

/**
 * Full collections are expensive. After the first checkpoint, run one only
 * after at least 512 MiB of new heap has accumulated.
 */
export function shouldCollectRelatedSearchContextGarbage(
  heapUsedBytes: number,
  lastGcHeapUsedBytes: number | null,
): boolean {
  if (!Number.isFinite(heapUsedBytes) || heapUsedBytes < 0) return false;
  if (lastGcHeapUsedBytes === null) return true;
  if (!Number.isFinite(lastGcHeapUsedBytes) || lastGcHeapUsedBytes < 0) return true;
  return heapUsedBytes - lastGcHeapUsedBytes >= RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES;
}

export interface RelatedSearchContextGcDecision {
  shouldCollect: boolean;
  reason: string;
  /** The current anonymous-footprint sample could not be used. */
  usedHeapOnlyFallback: boolean;
}

function isFiniteNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Include the build guard's RSS + VmSwap signal without making /proc a build
 * prerequisite. Missing current anon telemetry falls back to the established
 * heap-only predicate; missing prior anon telemetry disables only its growth
 * comparison, while a valid current sample can still trip guard headroom.
 */
export function decideRelatedSearchContextGc(
  heapUsedBytes: number,
  lastGcHeapUsedBytes: number | null,
  anonFootprintMb: number | null,
  lastGcAnonFootprintMb: number | null,
  anonGuardCeilingMb: number | null,
): RelatedSearchContextGcDecision {
  const heapShouldCollect = shouldCollectRelatedSearchContextGarbage(
    heapUsedBytes,
    lastGcHeapUsedBytes,
  );
  const heapReason = lastGcHeapUsedBytes === null
    ? 'initial_heap_checkpoint'
    : Number.isFinite(lastGcHeapUsedBytes) && Number.isFinite(heapUsedBytes)
      ? 'heap_growth'
      : 'heap_baseline_unavailable';

  if (!isFiniteNonNegative(anonFootprintMb)) {
    return {
      shouldCollect: heapShouldCollect,
      reason: heapShouldCollect
        ? `${heapReason}+anon_telemetry_unavailable_heap_only`
        : 'anon_telemetry_unavailable_heap_gate_skipped',
      usedHeapOnlyFallback: true,
    };
  }

  const reasons: string[] = [];
  if (heapShouldCollect) reasons.push(heapReason);

  const anonGrowthAvailable = isFiniteNonNegative(lastGcAnonFootprintMb);
  if (anonGrowthAvailable
    && anonFootprintMb - lastGcAnonFootprintMb
      >= RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES / (1024 * 1024)) {
    reasons.push('anon_growth');
  }

  const guardCeilingAvailable = typeof anonGuardCeilingMb === 'number'
    && Number.isFinite(anonGuardCeilingMb)
    && anonGuardCeilingMb > 0;
  if (guardCeilingAvailable
    && anonFootprintMb >= anonGuardCeilingMb - RELATED_SEARCH_CONTEXT_GC_GUARD_HEADROOM_MB) {
    reasons.push('near_guard_ceiling');
  }

  if (reasons.length > 0) {
    if (!anonGrowthAvailable) reasons.push('anon_growth_unavailable');
    if (!guardCeilingAvailable) reasons.push('guard_ceiling_unavailable');
    return { shouldCollect: true, reason: reasons.join('+'), usedHeapOnlyFallback: false };
  }

  const unavailableSignals = [
    !anonGrowthAvailable ? 'anon_growth_unavailable' : null,
    !guardCeilingAvailable ? 'guard_ceiling_unavailable' : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    shouldCollect: false,
    reason: ['below_threshold', ...unavailableSignals].join('+'),
    usedHeapOnlyFallback: false,
  };
}

export interface RelatedSearchContextGcCounters {
  /** Scheduled checkpoints, including those where the decision skips GC. */
  samples: number;
  /** Successful `forceGc()` calls. */
  collections: number;
}

export function createRelatedSearchContextGcCounters(): RelatedSearchContextGcCounters {
  return { samples: 0, collections: 0 };
}

export function recordRelatedSearchContextGcSample(counters: RelatedSearchContextGcCounters): void {
  counters.samples += 1;
}

export function recordRelatedSearchContextGcCollection(counters: RelatedSearchContextGcCounters): void {
  counters.collections += 1;
}
