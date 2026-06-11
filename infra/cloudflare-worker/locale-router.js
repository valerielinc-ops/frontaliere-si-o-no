/**
 * Cloudflare Worker — locale router for frontaliereticino.ch
 *
 * Keeps every public URL identical (frontaliereticino.ch/en/...), but serves
 * the non-primary locale subtrees from separate GitHub Pages repos so no
 * single repo trips the 10 GB Pages cap.
 *
 *   /en, /en/*, /en.html  -> origin-en.frontaliereticino.ch  (repo frontaliere-en)
 *   /de, /de/*, /de.html  -> origin-de.frontaliereticino.ch  (repo frontaliere-de)
 *   /fr, /fr/*, /fr.html  -> origin-fr.frontaliereticino.ch  (repo frontaliere-fr)
 *   everything else        -> default Pages origin (IT) passthrough
 *
 * The origin-* subdomains are DNS-only (gray-cloud) GitHub Pages custom
 * domains, reachable only from this Worker — never exposed to users. The Host
 * the user sees never changes; only the upstream fetch target's hostname is
 * rewritten. Because the fetch target URL carries the origin-* host, Cloudflare
 * sends `Host: origin-{loc}.frontaliereticino.ch` upstream, which is what makes
 * GitHub Pages match the shard repo's custom domain.
 *
 * Caching: shard responses are cached by Cloudflare's NATIVE edge cache via
 * `cf: { cacheEverything, cacheTtl }` on the origin fetch — NOT the Workers
 * Cache API. The previous caches.default/last-known-good machinery was removed
 * (2026-06-11) because:
 *   1. Every Cache API operation is logged in zone analytics as a synthetic
 *      `requestSource: edgeWorkerCacheAPI` row — cache.match() MISSes show up
 *      as edgeResponseStatus **504** (~124k/day) and cache.put()s as 204
 *      (~80k/day). Those phantom 504s (User-Agent empty, protocol UNK,
 *      originResponseDurationMs 0, zero eyeball rows) were repeatedly misread
 *      as a real outage ("26% of requests fail") and burned three PR cycles
 *      (#1791 regression, #1814 hotfix, #1830 no-op). Real client traffic on
 *      the shards is clean: zero eyeball 504s/day, ~50×503/day zone-wide.
 *   2. caches.default is per-colo and ephemeral; cf-native caching is tiered
 *      (upper-tier colos shared), so origin fetches drop further.
 * Do NOT reintroduce caches.default here without filtering monitoring to
 * `requestSource: "eyeball"` first (scripts/lib/cf-analytics.mjs does this).
 *
 * Asset/data/og refs in shard HTML are CDN-absolute (since #1665), so those
 * requests bypass this Worker entirely.
 *
 *   /rss-en.xml, /sitemap-*  -> tiny root files kept in the main repo (passthrough)
 */

const SHARD_ORIGIN = {
  en: 'origin-en.frontaliereticino.ch',
  de: 'origin-de.frontaliereticino.ch',
  fr: 'origin-fr.frontaliereticino.ch',
};

// First path segment must be exactly en|de|fr, followed by end, slash, or the
// .html locale-homepage file. Anything like /rss-en.xml or /enterprise stays
// on the main origin. (The Cloudflare route patterns already scope the Worker
// to these prefixes; this regex is the in-code guard.)
const LOCALE_RE = /^\/(en|de|fr)(\/|$|\.html$)/;

// Edge-cache TTLs for shard pages. Two layers, deliberately different:
//
//   ORIGIN_CACHE_TTL (2h) — `cf.cacheTtl` on the origin fetch: CF caches the
//   ORIGIN response (tiered/cross-colo) so repeat misses don't re-contact
//   GitHub Pages. Kept at 2h because with cacheEverything it also negative-
//   caches origin 404s: a page that flips 404→200 on deploy may serve a
//   cached 404 from an already-probed colo for up to this TTL, and deploys
//   land 2-3×/day — 2h bounds that staleness window.
//
//   CACHE_MAX_AGE (6h) — `max-age`/`s-maxage` stamped on the 200 responses we
//   return: CF caches the WORKER response eyeball-side, so repeat hits don't
//   re-invoke the Worker at all — the lever that keeps frontaliere-locale-router
//   under the free-tier 100k/day cap (measured 2026-06-11: ~144k inv/day,
//   ~63% AI crawlers re-crawling; raised 2h→6h to absorb more repeats).
//   Safe against stale-HTML 404s: superseded CDN asset hashes are retained
//   GRACE_DAYS=7 (prune-cdn-assets.mjs), far longer than this TTL, so HTML
//   served up to 6h stale still resolves every referenced /assets hash. Live
//   job data is client-fetched fresh from the CDN at runtime (not baked into
//   this cached HTML), so a 6h-stale SEO shell is fine.
const CACHE_MAX_AGE = 21600; // 6 h — eyeball-side (Worker response)
const ORIGIN_CACHE_TTL = 7200; // 2 h — origin-fetch side (cf.cacheTtl)

// Cache-Control stamped on shard 404s. ~51k/day of shard traffic is crawlers
// re-fetching DEAD job URLs from memory (old canton/slug variants, pruned
// jobs) — 404 is the correct status (no page can exist for them: the
// traffic-evidence gate caps soft-landing emission, and 391k bridge pages
// would blow the Pages 10 GB cap), but without Cache-Control every repeat hit
// re-invokes the Worker. s-maxage lets the edge absorb repeats; short
// browser max-age so a human who lands on a just-published URL that
// transiently 404'd retries fresh soon after.
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=300, s-maxage=7200';

// Per-attempt upstream timeout + one retry. A healthy shard origin answers in
// ~0.1-0.2s, so 6s is generous for a slow-but-ok fetch yet fails a hung
// connection fast; 6s×2=12s stays comfortably under Cloudflare's gateway
// timeout so our graceful 503 path can run. Measured (2026-06-11): origin
// fetches succeed first-try (~zero retries — Worker subrequests/day ≈
// cache-miss invocations/day), so this is a safety net, not a hot path.
const ORIGIN_TIMEOUT_MS = 6000;
const ORIGIN_RETRIES = 1; // total attempts = ORIGIN_RETRIES + 1

// Single upstream attempt bounded by an AbortController timeout. `cfOpts`
// carries the cf-native caching directives for shard fetches (tiered edge
// cache keyed on the upstream origin-{loc} URL — unique per locale+path, so
// locales can never collide). NOTE: do not add `cf.cacheKey` — custom cache
// keys are Enterprise-only and would be silently ignored or rejected.
async function fetchOriginOnce(upstream, request, cfOpts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(new Request(upstream, request), {
      signal: controller.signal,
      ...(cfOpts ? { cf: cfOpts } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the shard origin with one retry. Retries only on a thrown error
// (timeout/network) or a 5xx — a 4xx (e.g. a real Pages 404) is returned as-is.
// Throws only if every attempt threw.
async function fetchOriginWithRetry(upstream, request, cfOpts) {
  let lastErr;
  for (let attempt = 0; attempt <= ORIGIN_RETRIES; attempt++) {
    try {
      const resp = await fetchOriginOnce(upstream, request, cfOpts);
      if (resp.status < 500 || attempt === ORIGIN_RETRIES) return resp;
    } catch (err) {
      lastErr = err;
      if (attempt === ORIGIN_RETRIES) throw err;
    }
  }
  throw lastErr;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(LOCALE_RE);

    if (!match) {
      // IT + shared (sitemaps, robots, rss, favicon, /...) — passthrough.
      // DEFENSIVE / CURRENTLY UNREACHABLE: wrangler.toml scopes the Worker to
      // locale routes only (/en, /de, /fr) so IT traffic bypasses the Worker
      // entirely as a pure CF passthrough and never reaches this branch.  The
      // timeout+retry guard mirrors the shard-origin layer and is ready if the
      // route scope is ever expanded to cover IT traffic. No cf caching opts:
      // IT passthrough must respect the zone's own cache rules.
      try {
        return await fetchOriginWithRetry(url, request);
      } catch {
        return new Response('Origin unavailable', { status: 503 });
      }
    }

    const origin = SHARD_ORIGIN[match[1]];
    const upstream = new URL(request.url);
    upstream.hostname = origin; // rewrite Host only; path + query preserved

    let resp;
    try {
      resp = await fetchOriginWithRetry(upstream, request, {
        cacheEverything: true,
        cacheTtl: ORIGIN_CACHE_TTL,
      });
    } catch {
      // Every attempt timed out / threw — no origin response. Short Retry-After:
      // measured failure rate at this layer is ~0.02% (50×503/day zone-wide),
      // and CF's tiered cache absorbs repeats, so a transient blip self-heals.
      return new Response('Shard origin unavailable', {
        status: 503,
        headers: { 'Retry-After': '30' },
      });
    }

    // GitHub Pages 301s a dir path without trailing slash (e.g. /en/lavoro ->
    // /en/lavoro/). If that Location is absolute on the hidden origin host, the
    // browser would jump to origin-{loc}.frontaliereticino.ch — exposing the
    // origin and changing the visible URL. Rewrite any such Location back to the
    // public apex so the user never leaves frontaliereticino.ch. (Indexed paths
    // use trailing-slash canonicals → 200, no redirect; this covers the edge.)
    const loc = resp.headers.get('location');
    if (loc) {
      let locUrl = null;
      try {
        locUrl = new URL(loc, upstream); // resolves relative Locations too
      } catch {
        locUrl = null; // non-URL Location header → leave untouched
      }
      if (locUrl && locUrl.hostname === origin) {
        locUrl.hostname = url.hostname; // public apex
        const headers = new Headers(resp.headers);
        headers.set('location', locUrl.toString());
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
    }

    // Stamp Cache-Control on successful GETs so browsers and Cloudflare's
    // eyeball-side edge cache (s-maxage) can serve repeats without re-invoking
    // the Worker. Single body consumer — no buffering or stream tee needed
    // (the multi-consumer tee deadlock of #1791/#1814 is structurally gone
    // along with the Cache API writes that required it).
    if (request.method === 'GET' && resp.status === 200) {
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
      return new Response(resp.body, { status: 200, statusText: resp.statusText, headers });
    }

    // Stamp Cache-Control on 404s too: see NOT_FOUND_CACHE_CONTROL. GitHub
    // Pages sends no Cache-Control on its 404 page, so without this every
    // crawler re-fetch of a dead URL re-invokes the Worker.
    if (request.method === 'GET' && resp.status === 404) {
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', NOT_FOUND_CACHE_CONTROL);
      return new Response(resp.body, { status: 404, statusText: resp.statusText, headers });
    }

    return resp;
  },
};
