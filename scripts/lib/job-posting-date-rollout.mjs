import { resolveReportedPostingDate } from './job-posting-date.mjs';

/** Publication dates require explicit source evidence, including legacy records.
 * The callback argument remains for compatibility but is never evaluated.
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, _legacyDate, now) {
  // Keep the rollout boundary fail-closed even if a compatibility caller
  // reaches this wrapper before the stricter validator below.
  if (input?.postingDateSource !== 'reported') return null;
  return resolveReportedPostingDate(input, now);
}
