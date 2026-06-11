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
 * Locale responses are cached via caches.default (5-min TTL) to cut repeated
 * shard round-trips. Asset/data/og refs in shard HTML are CDN-absolute (since
 * #1665), so those requests bypass this Worker entirely.
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

// TTL for locale pages cached in the Workers Cache API + Cloudflare edge
// (s-maxage). Raised 300s -> 3600s (2026-06-10) to absorb far more repeat/
// overlapping hits as cf HITs that DON'T re-invoke the Worker — the lever that
// keeps frontaliere-locale-router under the free-tier 100k/day cap once the
// asset fan-out is gone (#1665 + route drop). Safe against stale-HTML 404s:
// superseded CDN asset hashes are retained GRACE_DAYS=7 (prune-cdn-assets.mjs),
// far longer than this TTL, so HTML served up to 2h stale still resolves every
// referenced /assets hash. Live job data is client-fetched fresh from the CDN at
// runtime (not baked into this cached HTML), so a 2h-stale SEO shell is fine.
// Bumped 3600->7200 (2026-06-10): on the free plan the Worker is mandatory for
// the shard Host rewrite (Origin Rules' Host-header override is paid-only), so
// edge caching is the only lever left to cut invocations under the 100k/day cap.
const CACHE_MAX_AGE = 7200; // 2 h

// Per-attempt upstream timeout + one retry. The shard origins are gray-cloud
// GitHub Pages; under the Worker's aggregate cache-miss fan-out they
// intermittently drop/stall the connection, so a single naked fetch surfaces a
// user-facing 504 (observed ~107k/day, edgeResponseStatus=504 with
// originResponseStatus=0 = no origin response). An AbortController bounds each
// attempt; one retry rides out a transient stall without hanging toward CF's
// 100s gateway ceiling.
const ORIGIN_TIMEOUT_MS = 12000;
const ORIGIN_RETRIES = 1; // total attempts = ORIGIN_RETRIES + 1

// Last-known-good retention. On EVERY successful 200 we also stash a copy under
// a private cache key with a long TTL; when a later origin fetch fails or 5xxes
// we serve that copy (stale-while-error) instead of a 504. Shard pages are SEO
// shells whose live job data is client-fetched fresh at runtime, so a stale
// shell served only during an origin outage is strictly better than an error.
const LKG_MAX_AGE = 604800; // 7 d

// Private cache key for the last-known-good copy of a URL. A synthetic host
// keeps it from ever colliding with real request URLs (incl. look-alike query
// strings), so genuine traffic can neither read nor poison the fallback slot.
function lkgKey(publicUrl) {
  return new Request(`https://lkg.invalid/${encodeURIComponent(publicUrl)}`);
}

// Single upstream attempt bounded by an AbortController timeout.
async function fetchOriginOnce(upstream, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(new Request(upstream, request), { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the shard origin with one retry. Retries only on a thrown error
// (timeout/network) or a 5xx — a 4xx (e.g. a real Pages 404) is returned as-is.
// Throws only if every attempt threw.
async function fetchOriginWithRetry(upstream, request) {
  let lastErr;
  for (let attempt = 0; attempt <= ORIGIN_RETRIES; attempt++) {
    try {
      const resp = await fetchOriginOnce(upstream, request);
      if (resp.status < 500 || attempt === ORIGIN_RETRIES) return resp;
    } catch (err) {
      lastErr = err;
      if (attempt === ORIGIN_RETRIES) throw err;
    }
  }
  throw lastErr;
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(LOCALE_RE);

    if (!match) {
      // IT + shared (sitemaps, robots, rss, favicon, /...) — straight passthrough.
      return fetch(request);
    }

    const cache = caches.default;
    // Strip per-request headers from the cache key so all users share the same
    // cached entry for a given URL.
    const cacheKey = new Request(url.toString());

    if (request.method === 'GET') {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const origin = SHARD_ORIGIN[match[1]];
    const upstream = new URL(request.url);
    upstream.hostname = origin; // rewrite Host only; path + query preserved

    let resp;
    try {
      resp = await fetchOriginWithRetry(upstream, request);
    } catch {
      resp = null; // every attempt timed out / threw — no origin response
    }

    // Origin produced nothing usable (timeout/network) or a 5xx → fall back to
    // the last-known-good copy so the user gets a stale page, not a 504.
    if (!resp || resp.status >= 500) {
      if (request.method === 'GET') {
        const lkg = await cache.match(lkgKey(url.toString()));
        if (lkg) {
          const headers = new Headers(lkg.headers);
          headers.set('X-Shard-Fallback', 'lkg'); // stale-while-error marker
          return new Response(lkg.body, { status: 200, statusText: 'OK', headers });
        }
      }
      // No fallback available. Surface 503 if we never got a response at all,
      // otherwise let the genuine origin 5xx through unchanged.
      if (!resp) return new Response('Shard origin unavailable', { status: 503 });
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

    // Cache successful GET responses and stamp Cache-Control so Cloudflare CDN
    // can also serve from edge without re-entering the Worker.
    if (request.method === 'GET' && resp.status === 200) {
      // Clone the origin response up front so we can write two cache entries
      // (short-TTL serving copy + long-TTL last-known-good) plus the returned
      // body from one upstream read.
      const lkgSource = resp.clone();

      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
      const cacheable = new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
      const toReturn = cacheable.clone();
      ctx.waitUntil(cache.put(cacheKey, cacheable));

      // Refresh the long-lived fallback copy on every successful fetch.
      const lkgHeaders = new Headers(lkgSource.headers);
      lkgHeaders.set('Cache-Control', `public, max-age=${LKG_MAX_AGE}`);
      ctx.waitUntil(
        cache.put(
          lkgKey(url.toString()),
          new Response(lkgSource.body, { status: 200, statusText: 'OK', headers: lkgHeaders }),
        ),
      );

      return toReturn;
    }

    return resp;
  },
};
