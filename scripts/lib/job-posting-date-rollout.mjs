import { resolveReportedPostingDate } from './job-posting-date.mjs';

/** Publication dates require explicit source evidence, including legacy records.
 * The callback argument remains for compatibility but is never evaluated.
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, _legacyDate, now) {
  return resolveReportedPostingDate(input, now);
}
