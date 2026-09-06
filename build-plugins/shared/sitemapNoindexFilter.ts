/**
 * Drop the `<url>` entries whose page the build rendered `noindex` (issue #7741).
 *
 * The bug class this closes: every SEO plugin builds its sitemap from a
 * DATA-driven condition (a municipality is above floor, a bucket has events, a
 * ladder spans N pages) while the page's `robots` comes from a SECOND,
 * independent condition — the `MIN_INDEXABLE_WORDS` gate on the rendered body.
 * Nothing makes the two agree, so a page that renders thin stays listed, and
 * `noindex` + present in a sitemap is a contradictory signal to Google AND a
 * deploy-blocking `error` in `scripts/validate-soft404.mjs` (Rule 4, "Sitemap
 * URL has noindex"). Each plugin already MEASURES the offending pages — that is
 * its `thinPages` counter — and then throws the measurement away.
 *
 * Shared rather than copy-pasted per plugin so the `<loc>`-to-path mapping
 * cannot drift between the seven callers (AGENTS.md #6).
 */
import { BASE_URL } from '../constants';

const ENTRY_LOC_RE = /<loc>([^<]+)<\/loc>/;

/**
 * The site-relative path of a `<url>` entry — the same string a render returns
 * as `urlPath`, so the sitemap entries and the rendered pages are comparable.
 */
export function sitemapEntryPath(entry: string): string {
  const loc = ENTRY_LOC_RE.exec(entry)?.[1] ?? '';
  return loc.startsWith(BASE_URL) ? loc.slice(BASE_URL.length) : loc;
}

/**
 * `entries` minus the ones whose path is in `noindexPaths`.
 *
 * An EMPTY set is returned unchanged, which is what makes this safe in a
 * `BUILD_LOCALE` shard that never rendered the sitemap's locale: a build that
 * did not render a page cannot claim the page is thin, so it drops nothing.
 */
export function dropNoindexUrlEntries(entries: string[], noindexPaths: ReadonlySet<string>): string[] {
  if (noindexPaths.size === 0) return entries;
  return entries.filter((entry) => !noindexPaths.has(sitemapEntryPath(entry)));
}
