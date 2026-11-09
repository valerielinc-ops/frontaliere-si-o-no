export const RELATED_SEARCH_CONTEXT_GC_CHECKPOINT = 2_500;

/** Disable only the periodic matching-phase checkpoints for a build canary. */
export function isRelatedSearchContextGcEnabled(value: string | undefined): boolean {
  return value !== '0';
}

/**
 * The first 2,500 candidates follow the allocations left by the preceding SEO
 * page phases. One collection there reclaims that dead state before the long
 * matching pass; repeated collections later reclaim little and stall matching.
 */
export function shouldForceRelatedSearchContextGc(processedContexts: number): boolean {
  return processedContexts === RELATED_SEARCH_CONTEXT_GC_CHECKPOINT;
}
