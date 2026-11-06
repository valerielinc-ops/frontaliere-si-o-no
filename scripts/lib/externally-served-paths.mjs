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

import path from 'node:path';

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
 *
 * `${prefix}.html` counts too. `matchSection`
 * (infra/cloudflare-worker/locale-router.js) claims the flat root explicitly —
 * `pathname === `${route.prefix}.html`` — so the edge serves it from the shard
 * whatever this build thinks. Callers here are `validate-sitemap-pages.mjs`,
 * `validate-sitemap-links.mjs` and `audit-hreflang.mjs`: without this case a
 * flat `/articoli-frontaliere.html` reads as served BY THIS BUILD, so the
 * validators look for a file that is not there and fail the dist — blocking
 * publish for a URL the shard was always going to answer. The hreflang audit
 * gets the mirror-image error and passes something it should have flagged.
 *
 * Third instance of one blind spot in a single session: `dist/<locale>.html`
 * (a locale classifier matching `rel === 'en'` and `rel.startsWith('en/')` but
 * not `en.html`), then `isUnshippablePath`, now this. A prefix test sees the
 * directory and misses its flat twin unless the twin is spelled out.
 */
export function isExternallyServedPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return EXTERNALLY_SERVED_PREFIXES.some(
    (prefix) => p === prefix || p === `${prefix}.html` || p.startsWith(`${prefix}/`),
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

/**
 * Convert an absolute `dist/` file path back into the URL path it serves.
 *
 *   <dist>/articoli-frontaliere/x/index.html → /articoli-frontaliere/x
 *   <dist>/articoli-frontaliere/x.html       → /articoli-frontaliere/x
 *   <dist>/index.html                        → /
 *
 * Returns `null` when `absPath` is not under `distDir` — the caller must not
 * infer anything from a path it cannot place.
 */
export function distFileToUrlPath(absPath, distDir) {
  if (typeof absPath !== 'string' || typeof distDir !== 'string') return null;
  const rel = path.relative(distDir, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let p = rel.split(path.sep).join('/');
  if (p === 'index.html') p = '';
  else if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length);
  else if (p.endsWith('.html')) p = p.slice(0, -'.html'.length);
  return p === '' ? '/' : `/${p}`;
}

/**
 * Wrap a `dist/`-existence predicate so a target under an externally-served
 * section answers TRUE even though this build emits no file for it.
 *
 * Why the hreflang pass needs this
 * -------------------------------
 * `transformHreflang` strips every `<link rel="alternate">` whose target has
 * no file in `dist/`, on the premise that "no file ⇒ broken link". Since
 * `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` / `ARTICOLISVIZZERA_BUILD_EMIT_SKIP`
 * were turned on (2026-07-29) that premise is false for the article sections:
 * their pages are rendered and served by the articles repo's shards, answer
 * 200 at the apex, and are deliberately absent here — the same inference this
 * module already corrects for the sitemap validators.
 *
 * The consequence was measured on post-deploy run 31096435063:
 * `/comparatori/lamal-vs-cmi/`, a bridge to the article
 * `/articoli-frontaliere/lamal-vs-cmi-frontaliere/`, shipped with its `it` and
 * `x-default` alternates stripped — the two whose target is that article — and
 * `audit:hreflang` then failed the build's own output with
 * `has only 3 hreflang entries (need 4 locales + x-default)`.
 *
 * `scripts/audit-hreflang.mjs` already exempts these URLs in `targetExists()`.
 * Wiring the same exemption into the emit side is what makes the two agree:
 * without it the build is guaranteed to produce a defect it then audits for.
 */
export function allowExternallyServedTargets(existsCheck, distDir) {
  return (absPath) => {
    if (existsCheck(absPath)) return true;
    const urlPath = distFileToUrlPath(absPath, distDir);
    return urlPath !== null && isExternallyServedPath(urlPath);
  };
}
