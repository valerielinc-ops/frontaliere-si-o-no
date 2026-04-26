/**
 * Hreflang Guard — gating helper for cross-locale alternates.
 *
 * Why this exists
 * ---------------
 * Semrush's 2026-04-26 audit flagged 1.463 broken internal links (Issue 8/E1)
 * + 6 wrong hreflang targets (Issue 25/E8). ~90% of them are
 * `<link rel="alternate" hreflang>` tags whose target HTML file does NOT
 * actually ship in `dist/` — typically because a blog article was created
 * in IT but the EN/DE/FR translations have not been generated yet.
 *
 * Google's documented preference: hreflang alternates should ONLY be
 * emitted for locales whose translation actually exists. Missing hreflang
 * is acceptable; broken hreflang is a hard error.
 *
 * This module is the single shared filter every emitter (and the post-
 * processor pass) runs alternates through before writing HTML.
 *
 * @see hreflangPostprocessPlugin — universal pass that walks dist/ and
 *      strips broken alternates without touching the per-plugin emitters.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface LocaleAlternates {
  readonly locale: string;
  readonly url: string;
}

/**
 * Filter hreflang alternates: keep only locales whose HTML file actually
 * exists in dist/. Prevents Semrush "broken hreflang" + "broken internal
 * link" issues by emitting hreflangs only for translated pages that ship.
 *
 * Accepts either absolute URLs (with or without trailing slash) or
 * pathname-only entries. The lookup checks for both `dist/<path>/index.html`
 * and `dist/<path>.html` (flat sibling) so it survives the
 * flatHtmlRedirectPlugin rewrite pass.
 *
 * Pure function: never mutates the input array.
 */
export function filterExistingAlternates(
  alternates: readonly LocaleAlternates[],
  distDir: string,
  baseUrl: string,
): readonly LocaleAlternates[] {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return alternates.filter(({ url }) => {
    const pathname = stripBaseAndTrailingSlash(url, trimmedBase);
    if (pathname === '' || pathname === '/') {
      // Root index — always exists if the build ran at all.
      return fs.existsSync(path.join(distDir, 'index.html'));
    }
    const candidate = path.join(distDir, pathname, 'index.html');
    const flat = path.join(distDir, `${pathname}.html`);
    return fs.existsSync(candidate) || fs.existsSync(flat);
  });
}

/**
 * Convert a (possibly absolute) URL into a leading-slash pathname with
 * any trailing slash stripped. Resilient to query strings + fragments
 * (rare in hreflang but cheap to handle).
 */
function stripBaseAndTrailingSlash(url: string, trimmedBase: string): string {
  let p = url;
  if (p.startsWith(trimmedBase)) p = p.slice(trimmedBase.length);
  // Drop query/hash if anything ever sneaks in.
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  // Strip ALL trailing slashes (handles `//` edge case).
  p = p.replace(/\/+$/, '');
  if (p === '') return '';
  return p.startsWith('/') ? p.slice(1) : p;
}
