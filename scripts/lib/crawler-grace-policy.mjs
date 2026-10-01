/**
 * Shared miss-grace policy for crawler merge and retirement paths.
 *
 * Keeping this value in one module prevents a writer-side integrity proof from
 * drifting away from the merge policy that decides when a missing job may be
 * retired.
 */
export const CRAWLER_GRACE_PERIOD_MAX_MISSES = 2;

// A small, bounded detail outage may be transient (for example a source WAF
// challenging two pages while the listing itself remains complete). It is
// safe to reuse only the same URL from the previous snapshot, and only below
// this ratio. The source-specific validator still rejects missing identities,
// incomplete listings, and rows without a valid stored body.
export const CRAWLER_DETAIL_FAILURE_MAX_RATIO = 0.15;

/**
 * Whether a detail-failure set is small enough for the source-specific
 * previous-snapshot fallback. Malformed counters fail closed.
 *
 * @param {number} detailFailureCount
 * @param {number} discoveredCount
 * @returns {boolean}
 */
export function isDetailFailureWithinGrace(detailFailureCount, discoveredCount) {
  return Number.isInteger(detailFailureCount)
    && Number.isInteger(discoveredCount)
    && discoveredCount > 0
    && detailFailureCount >= 0
    && detailFailureCount <= discoveredCount
    && detailFailureCount / discoveredCount <= CRAWLER_DETAIL_FAILURE_MAX_RATIO;
}
