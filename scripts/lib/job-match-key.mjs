/**
 * Extract a stable job identifier from a job's source URL.
 *
 * Crawler diff logic (mergeJobs, mergePreserveLocaleData) keys jobs by the
 * source URL. When a vendor renames the slug-portion of the URL but keeps the
 * underlying job ID, the URL key changes and the old job is silently dropped
 * — losing its previousSlugs, locale translations, and SEO equity. The old
 * slug then becomes an expired soft-landing while the new slug emits as a
 * "new" job with no link continuity.
 *
 * This helper extracts the most stable token in the URL so renames don't
 * fragment the match key:
 *   1. UUID (canonical form like PwC's `0441e237-ebd9-4263-9fe5-e21facbd03ba`)
 *   2. Long numeric ID (≥6 digits — Workday, Greenhouse, etc.)
 *   3. Long alphanumeric token (≥10 chars, likely a content hash)
 *   4. Full normalized URL (legacy fallback — no regression for crawlers that
 *      embed only the slug in the URL).
 *
 * The result is always lowercase. Empty input returns an empty string so
 * callers can fall back to slug-keyed matching.
 *
 * @param {string} url - source URL of the job
 * @returns {string} stable identifier
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUM_ID_RE = /\b\d{6,}\b/;
const HEX_TOKEN_RE = /\b[0-9a-f]{10,}\b/i;

export function extractStableJobId(url) {
  if (!url) return '';
  const u = String(url).trim().replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();
  if (!u) return '';

  const uuid = u.match(UUID_RE);
  if (uuid) return `uuid:${uuid[0]}`;

  const num = u.match(NUM_ID_RE);
  if (num) return `num:${num[0]}`;

  const hex = u.match(HEX_TOKEN_RE);
  if (hex) return `hex:${hex[0]}`;

  return `url:${u}`;
}
