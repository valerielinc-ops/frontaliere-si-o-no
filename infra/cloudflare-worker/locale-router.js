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
 * rewritten.
 *
 * NOT routed here (served by their own origins directly, no rewrite):
 *   /assets/*, /data/*, /og/*  -> already absolute on cdn.frontaliereticino.ch
 *   /rss-en.xml, /sitemap-*    -> tiny root files kept in the main repo
 */

const SHARD_ORIGIN = {
  en: 'origin-en.frontaliereticino.ch',
  de: 'origin-de.frontaliereticino.ch',
  fr: 'origin-fr.frontaliereticino.ch',
};

// First path segment must be exactly en|de|fr, followed by end, slash, or the
// .html locale-homepage file. Anything like /rss-en.xml or /enterprise stays
// on the main origin.
const LOCALE_RE = /^\/(en|de|fr)(\/|$|\.html$)/;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(LOCALE_RE);

    if (match) {
      const origin = SHARD_ORIGIN[match[1]];
      const upstream = new URL(request.url);
      upstream.hostname = origin; // rewrite Host only; path + query preserved
      // Preserve method/body/headers; the user-facing URL is unchanged.
      return fetch(new Request(upstream, request));
    }

    // IT + shared (sitemaps, robots, rss, favicon, /...) — straight passthrough.
    return fetch(request);
  },
};
