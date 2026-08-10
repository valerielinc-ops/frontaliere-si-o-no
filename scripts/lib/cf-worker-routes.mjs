/**
 * Which apex paths the Worker answers — and which host the copy a visitor is
 * served is actually keyed on (#5483).
 *
 * THE DEFECT THIS EXISTS FOR. `infra/cloudflare-worker/locale-router.js`'s
 * serveShard() rewrites the upstream Host to a shard origin and fetches it with
 * `cf: { cacheEverything: true, cacheTtl: ORIGIN_CACHE_TTL }`. The entry that
 * then serves the user is keyed on
 * `https://origin-<shard>.frontaliereticino.ch/<path>`, NOT on the apex URL the
 * browser asked for. So a `files: ['https://frontaliereticino.ch/de/']` purge
 * returns 200, prints a ✅, and moves nothing.
 *
 * The proof is arithmetic, not "it stayed HIT": cf-locale-failover-setup.mjs
 * pins the apex rule to APEX_EDGE_TTL_SECONDS = 300, and /cerca-lavoro-ticino/
 * was measured at `age 6333` — 21× that TTL and comfortably under the Worker's
 * 7200s ORIGIN_CACHE_TTL. No entry governed by the apex rule can be that old.
 * (A successful purge followed by an immediate refill has the SAME signature as
 * a blind one, which is why "still HIT after the purge" proves nothing and cost
 * this issue its first, wrong diagnosis.)
 *
 * The blindness is NOT zone-wide: it is exactly the set of paths on a Worker
 * route. Plain IT apex traffic (`/`, `/blog/…`, `/aziende/…`) is passthrough,
 * keyed on the apex, and a per-URL purge there works — measured `/` at age 153
 * against the same 300s TTL. `infra/cloudflare-worker/wrangler.toml` is the
 * boundary, so this module reads it rather than restating it.
 *
 * WHY A WARNING AND NOT AN AUTOMATIC EXPANSION. A blind purge and a purge
 * expanded to the WRONG origin look identical from the caller's side — both
 * return 200 — so a mis-derived expansion would replace a known gap with false
 * assurance, which is the failure mode this issue is about. The mapping is only
 * unambiguous for shard paths (locale + section); the EDGE_PUSHED_FILES paths
 * on this same route list are served from R2 under a `cdn.frontaliereticino.ch`
 * key with a DIFFERENT path (`/edge/<name>`), so there is no single rule. What
 * is decidable without guessing is whether the caller ALREADY named a non-apex
 * companion for that path — that is what apexPurgeBlindSpots() answers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SECTION_ROUTES,
  SECTION_ORIGIN,
  SHARD_ORIGIN,
} from '../../infra/cloudflare-worker/locale-router.js';

export const APEX_HOST = 'frontaliereticino.ch';

export const WRANGLER_TOML_PATH = path.resolve(
  import.meta.dirname,
  '../../infra/cloudflare-worker/wrangler.toml',
);

/**
 * Every `pattern = "…"` in wrangler.toml's `routes` list.
 *
 * `#`-comment lines are dropped first: that file's comments are longer than its
 * data and quote route shapes in prose, so a naive scan would invent routes.
 */
export function readWorkerRoutePatterns(file = WRANGLER_TOML_PATH) {
  const patterns = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const match = /pattern\s*=\s*"([^"]+)"/.exec(line);
    if (match) patterns.push(match[1]);
  }
  return patterns;
}

/**
 * Cloudflare route matching, in the one shape this zone uses: `host/path`, with
 * an optional trailing `*`. Matched against pathname + search, because a route
 * WITHOUT the trailing star matches only the exact URL with no query string
 * (#2611) — the reason nearly every route here carries one.
 */
export function routePatternMatches(pattern, url) {
  const slash = pattern.indexOf('/');
  const host = slash === -1 ? pattern : pattern.slice(0, slash);
  const pathPattern = slash === -1 ? '/*' : pattern.slice(slash);
  if (host !== url.hostname) return false;
  const target = `${url.pathname}${url.search}`;
  return pathPattern.endsWith('*')
    ? target.startsWith(pathPattern.slice(0, -1))
    : target === pathPattern;
}

/** The first Worker route pattern that claims this URL, or null. */
export function workerRouteForUrl(url, patterns = readWorkerRoutePatterns()) {
  return patterns.find((pattern) => routePatternMatches(pattern, url)) ?? null;
}

/**
 * The shard origin host a SHARD path's cache entry is keyed on, or null when
 * the path is not served from a shard (apex passthrough, an R2-backed
 * EDGE_PUSHED_FILES path, an unsubscribe proxy).
 *
 * Section routes are checked BEFORE the locale regex, mirroring the Worker's
 * own dispatch order: `/de/jobs-im-tessin/…` is served by origin-ticino-de, not
 * by origin-de, and getting that backwards would name a host that never held
 * the entry.
 */
export function shardOriginForApexUrl(url) {
  if (url.hostname !== APEX_HOST) return null;
  const section = SECTION_ROUTES.find(
    (route) =>
      url.pathname === route.prefix ||
      url.pathname === `${route.prefix}.html` ||
      url.pathname.startsWith(`${route.prefix}/`),
  );
  if (section) return SECTION_ORIGIN[section.section]?.[section.locale] ?? null;
  const locale = /^\/(en|de|fr)(\/|$|\.html$)/.exec(url.pathname);
  if (locale) return SHARD_ORIGIN[locale[1]] ?? null;
  return null;
}

/**
 * The apex URLs in one purge list that sit on a Worker route and have NO
 * non-apex companion in the same list — i.e. the ones whose ✅ will not move
 * the copy a visitor gets.
 *
 * "Companion" is deliberately loose (same path, or a path ENDING in it) so the
 * two shapes already in production both count as covered: the shard form
 * (`origin-…/de/` for `/de/`) and the R2 form (`cdn…/edge/rss.xml` for
 * `/rss.xml`). Being loose here is the safe direction — a false "covered" is a
 * missing warning, while a false gap would train readers to ignore the warning.
 *
 * Unparseable entries are ignored: the caller's own cap/validation owns those.
 */
export function apexPurgeBlindSpots(urls, patterns = readWorkerRoutePatterns()) {
  const parsed = urls
    .map((raw) => {
      try {
        return new URL(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const companions = parsed.filter((url) => url.hostname !== APEX_HOST);

  const gaps = [];
  for (const url of parsed) {
    if (url.hostname !== APEX_HOST) continue;
    const pattern = workerRouteForUrl(url, patterns);
    if (!pattern) continue; // apex passthrough — this purge is the real one
    const covered = companions.some(
      (companion) =>
        companion.pathname === url.pathname || companion.pathname.endsWith(url.pathname),
    );
    if (covered) continue;
    gaps.push({
      url: url.toString(),
      pattern,
      expectedOrigin: shardOriginForApexUrl(url),
    });
  }
  return gaps;
}
