/**
 * slugify.mjs — the standard slug helper, split out of crawler-template.mjs.
 *
 * This is pure string work with a single dependency-free local import, so it
 * can be reached by scripts that run WITHOUT `npm ci`.
 *
 * Why it lives in its own module: `crawler-template.mjs` is the crawler
 * framework, and it imports `./prospector/public-fetch-policy.mjs`, which
 * imports the npm package `undici`. Any module that pulled `slugify` from
 * crawler-template therefore inherited the whole fetch stack — so a read-only
 * observer such as `scripts/check-pharmacy-data-health.mjs`, whose workflow
 * deliberately skips `npm ci` because it needs no network, died at module load
 * with `ERR_MODULE_NOT_FOUND: Cannot find package 'undici'` before it could
 * write its report. It was blind rather than red, which is the exact failure
 * class that monitor exists to close.
 *
 * `crawler-template.mjs` re-exports `slugify` from here, so every existing
 * `import { slugify } from './crawler-template.mjs'` keeps working unchanged.
 * New pure consumers should import it from this module instead.
 *
 * Guarded by `scripts/ci/check-dependency-free-import-closure.mjs`.
 */
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

/**
 * Standard slugify function. Parsers should use this to build slugs
 * consistently (lowercase, diacritics stripped, alphanumeric+dash only).
 * Trims at word boundary when the cap would split a token.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export function slugify(text = '', maxLength = 90) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(base, maxLength);
}
