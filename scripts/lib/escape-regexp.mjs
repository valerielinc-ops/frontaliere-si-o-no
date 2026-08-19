/**
 * escape-regexp — escape a literal so it can be embedded in a `RegExp`.
 *
 * Extracted because the identical one-liner existed in two places
 * (`scripts/lib/job-locale-utils.mjs` and, as of this change,
 * `scripts/lib/job-location-plausibility.mjs`), and AGENTS.md #6 asks for one
 * shared module rather than a second copy: a regex duplicated literally is a
 * drift waiting to happen, and this one guards user-supplied job data going
 * into a dynamically built pattern, where a missed metacharacter is a
 * mis-match, not a crash.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeRegExpLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
