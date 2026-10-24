import {
  resolveFirstSeenPostingDate,
  resolveReportedPostingDate,
  resolveSchemaPostingDate,
} from './job-posting-date.mjs';

/** Resolve the display date, preferring employer evidence over first observation.
 * The callback argument remains for compatibility but is never evaluated.
 */
export function hasPostingDateProvenance(input) {
  return input?.postingDateSource !== undefined && input?.postingDateSource !== null;
}

export function resolveRolloutPostingDate(input, _legacyDate, now) {
  return resolveReportedPostingDate(input, now) || resolveFirstSeenPostingDate(input, now);
}

/**
 * Resolve the JobPosting date without changing upstream source provenance.
 * Delegates to the never-null chain in job-posting-date.mjs (reported ->
 * first-seen -> observed -> build-clock). The former six-URL allowlist of
 * issue 12937 and the 1970 sentinel are gone: every active job qualifies.
 */
export function resolveRolloutSchemaPostingDate(input, now) {
  return resolveSchemaPostingDate(input, now);
}
