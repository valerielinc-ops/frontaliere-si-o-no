export const RELATED_SEARCH_CONTEXT_GC_WARMUP_CONTEXTS = 20_000;
export const RELATED_SEARCH_CONTEXT_GC_WARMUP_INTERVAL = 2_500;
export const RELATED_SEARCH_CONTEXT_GC_INTERVAL = 10_000;

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
