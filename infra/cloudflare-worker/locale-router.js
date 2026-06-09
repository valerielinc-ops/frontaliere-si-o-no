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
 * Also proxies /assets /data /og to the CDN: the shard-served locale pages
 * reference these SAME-ORIGIN (their HTML was captured before the pipeline's
 * /assets->cdn rewrite), but the bundle/data/og live on cdn.frontaliereticino.ch
 * and 404 on the apex — so without this, locale pages load with no CSS/JS.
 *
 *   /rss-en.xml, /sitemap-*  -> tiny root files kept in the main repo (passthrough)
 */

const SHARD_ORIGIN = {
  en: 'origin-en.frontaliereticino.ch',
  de: 'origin-de.frontaliereticino.ch',
  fr: 'origin-fr.frontaliereticino.ch',
};

// Static paths that live on the CDN, not the apex Pages origin. Shard locale
// pages reference them same-origin, so proxy them to the CDN.
const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const CDN_PATHS = /^\/(assets|data|og)\//;

// First path segment must be exactly en|de|fr, followed by end, slash, or the
// .html locale-homepage file. Anything like /rss-en.xml or /enterprise stays
// on the main origin. (The Cloudflare route patterns already scope the Worker
// to these prefixes; this regex is the in-code guard.)
const LOCALE_RE = /^\/(en|de|fr)(\/|$|\.html$)/;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Same-origin CDN paths from shard locale pages → serve from the CDN.
    if (CDN_PATHS.test(url.pathname)) {
      return fetch(CDN_BASE + url.pathname + url.search, request);
    }

    const match = url.pathname.match(LOCALE_RE);

    if (!match) {
      // IT + shared (sitemaps, robots, rss, favicon, /...) — straight passthrough.
      return fetch(request);
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

    return resp;
  },
};
