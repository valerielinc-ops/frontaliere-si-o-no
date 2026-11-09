export const RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS = 20_000;
export const RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL = 2_500;
export const RELATED_SEARCH_CONTEXT_GC_INTERVAL = 10_000;
export const RELATED_SEARCH_CONTEXT_GC_MIN_GROWTH_BYTES = 512 * 1024 * 1024;

/** Disable only the periodic matching-phase checkpoints for a build canary. */
export function isRelatedSearchContextGcEnabled(value: string | undefined): boolean {
  return value !== '0';
}

/**
 * Sample/consider collection at bounded checkpoints. Dense warm-up points
 * include the 2,500-context boundary where the preceding SEO phases left dead
 * heap; later points keep transient allocations bounded through the full pass.
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
 * after at least 512 MiB of new heap has accumulated since the previous GC.
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
