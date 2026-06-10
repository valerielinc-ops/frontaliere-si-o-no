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
// far longer than this TTL, so HTML served up to 1h stale still resolves every
// referenced /assets hash. Live job data is client-fetched fresh from the CDN at
// runtime (not baked into this cached HTML), so a 1h-stale SEO shell is fine.
const CACHE_MAX_AGE = 3600; // 1 h

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
    const resp = await fetch(new Request(upstream, request));

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
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
      const cacheable = new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
      const toReturn = cacheable.clone();
      ctx.waitUntil(cache.put(cacheKey, cacheable));
      return toReturn;
    }

    return resp;
  },
};
