/**
 * Paths this repository LISTS but does not SERVE.
 *
 * The article sections moved to nanakokyobashi-rgb/frontaliere-articles (issue
 * #4974 item 3). That repo renders each article and pushes it straight to the
 * per-locale shard Pages repos, and `infra/cloudflare-worker/locale-router.js`
 * routes `/articoli-frontaliere/*` and `/articoli-svizzera/*` to
 * `origin-<section>-<locale>.frontaliereticino.ch` — those same shard repos.
 * This build is not on the serving path for an article at all.
 *
 * The sitemaps still (correctly) list every article: `pull-articles-api.mjs`
 * fetches them from the articles repo's published API, which is the authority
 * on what exists. What broke is the inference the dist/-existence checks make
 * from that listing — "a sitemap URL must resolve to a file in dist/". For an
 * article that premise is simply false now, and it blocked `deploy-publish`
 * for the WHOLE site: jobs, events and fuel prices stopped deploying because
 * of 11 article URLs.
 *
 * Measured 2026-08-03, which is what makes this an exclusion rather than a
 * weakening: eleven articles absent from this repo's `dist/` were published
 * from the articles repo and answered 200 at the apex and at their shard
 * origin, while this build had no file for any of them. Validating them here
 * checks an artifact nobody serves.
 *
 * SCOPE — article sections ONLY. Every other sharded section (ticino, zugo,
 * sangallo, …) is still BUILT here and pushed to its shard by `deploy.yml`, so
 * its pages do exist in `dist/` and must keep being validated. Deriving the
 * prefixes from the Worker's own `SECTION_ROUTES` rather than restating them
 * means this set cannot drift from what the edge actually routes away.
 *
 * NOT the end state. This build still emits article pages into `dist/` — they
 * are simply redundant now, and mostly stale. Removing that work is what the
 * `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` / `ARTICOLISVIZZERA_BUILD_EMIT_SKIP`
 * repo variables are for, flipped in lockstep with dropping both sections from
 * `deploy.yml`'s shard push loop. Until then this module keeps the gate honest
 * about what it can actually assert.
 */

import { SECTION_ROUTES } from '../../infra/cloudflare-worker/locale-router.js';

/** Sections whose pages are produced and served entirely outside this repo. */
export const EXTERNALLY_SERVED_SECTIONS = new Set([
  'articolifrontaliere',
  'articolisvizzera',
]);

/**
 * URL-path prefixes routed away from this build, e.g.
 * `/articoli-frontaliere`, `/en/cross-border-articles`, … — 8 entries, one per
 * section per locale, straight from the Worker's routing table.
 */
export const EXTERNALLY_SERVED_PREFIXES = SECTION_ROUTES
  .filter((r) => EXTERNALLY_SERVED_SECTIONS.has(r.section))
  .map((r) => r.prefix);

/**
 * True when `pathname` (a URL path, leading slash, no origin) belongs to a
 * section served from outside this build.
 *
 * Matches the prefix only at a segment boundary: `/articoli-frontaliere` and
 * `/articoli-frontaliere/foo/` match, `/articoli-frontaliere-altro/` does not.
 */
export function isExternallyServedPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return EXTERNALLY_SERVED_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(`${prefix}/`),
  );
}

/** Same test for a full URL; a non-URL string is treated as a path. */
export function isExternallyServedUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return isExternallyServedPath(new URL(url).pathname);
  } catch {
    return isExternallyServedPath(url);
  }
}
