/**
 * Shared miss-grace policy for crawler merge and retirement paths.
 *
 * Keeping this value in one module prevents a writer-side integrity proof from
 * drifting away from the merge policy that decides when a missing job may be
 * retired.
 */
export const CRAWLER_GRACE_PERIOD_MAX_MISSES = 2;
