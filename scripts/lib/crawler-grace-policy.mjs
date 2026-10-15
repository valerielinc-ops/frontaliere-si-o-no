// Kept as the compatibility import for existing crawler guards. The policy
// itself lives in one module so jobs and event crawlers cannot drift apart.
import {
  DETAIL_FAILURE_MAX_RATIO,
  isDetailFailureWithinGrace,
} from './detail-failure-reuse-policy.mjs';

/**
 * Shared miss-grace policy for crawler merge and retirement paths.
 *
 * Keeping this value in one module prevents a writer-side integrity proof from
 * drifting away from the merge policy that decides when a missing job may be
 * retired.
 */
export const CRAWLER_GRACE_PERIOD_MAX_MISSES = 2;

export { isDetailFailureWithinGrace };
export const CRAWLER_DETAIL_FAILURE_MAX_RATIO = DETAIL_FAILURE_MAX_RATIO;
