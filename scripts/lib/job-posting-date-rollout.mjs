import { resolveReportedPostingDate } from './job-posting-date.mjs';

/** Temporary migration boundary: absent markers retain their legacy behavior.
 * Explicit markers never fall back to collection clocks. Remove this legacy
 * branch only after refreshed producer coverage has been measured (phase B).
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, legacyDate, now) {
  return hasPostingDateProvenance(input)
    ? resolveReportedPostingDate(input, now)
    : legacyDate();
}
