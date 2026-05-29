/**
 * safe-location-token.mjs — guard a location value before it flows into a slug
 * or JSON-LD `addressLocality`.
 *
 * Crawlers build slugs like `slugify(`${title}-company-${raw.location}`)` and
 * set `addressLocality: loc`. A plain `raw.location || 'fallback'` does NOT
 * catch the *literal string* `"undefined"` / `"null"` (both truthy), so a
 * parser that returns those leaks `-undefined` into active job slugs (sitemap
 * canonical gate failure, issues #823/#824/#852) and `"undefined"` into
 * `JobPosting.jobLocation.address.addressLocality` (Google rejects the
 * structured data → de-index; AGENTS.md non-negotiable #3). Issues #900/#901.
 *
 * Use at every site that interpolates a parser-derived location into a slug.
 *
 * @param {unknown} value - raw location value from a detail parser.
 * @param {string} [fallback='svizzera'] - safe token when value is missing/invalid.
 * @returns {string} the trimmed value, or `fallback` if empty/`undefined`/`null`.
 */
export function safeLocationToken(value, fallback = 'svizzera') {
  const s = (value == null ? '' : String(value)).trim();
  if (s === '' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') {
    return fallback;
  }
  return s;
}
