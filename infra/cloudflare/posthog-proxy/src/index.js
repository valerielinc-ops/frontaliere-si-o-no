// First-party reverse proxy for PostHog EU Cloud.
//
// Served on https://t.frontaliereticino.ch (Cloudflare Worker custom domain) so
// analytics requests are same-origin and bypass ad-blockers that block
// *.posthog.com. The client points `api_host` at this domain (see
// services/posthog.ts). Without this proxy the host is NXDOMAIN and every
// PostHog event fails (observed 2026-06-09).
//
//   /static/*  -> eu-assets.i.posthog.com   (posthog-js bundle, cached at edge)
//   everything -> eu.i.posthog.com          (event ingestion / flags / etc.)
const API_HOST = 'eu.i.posthog.com';
const ASSET_HOST = 'eu-assets.i.posthog.com';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/static/')) {
      // posthog-js bundle: hashed, immutable static asset. Serve from the edge
      // cache and POPULATE it on miss — the previous code read caches.default but
      // never wrote it, so every /static/ hit re-fetched the origin (dead cache).
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;

      // Forward NO client headers: static assets need none, and forwarding
      // request.headers wholesale (as before) leaked the first-party `cookie` to
      // eu-assets and sent the wrong Host (t.frontaliereticino.ch) upstream.
      const response = await fetch(`https://${ASSET_HOST}${url.pathname}${url.search}`);

      // Only cache GET 200s with no Set-Cookie: cache.put rejects on Set-Cookie /
      // non-GET, and caching an error would poison the edge until TTL. waitUntil
      // keeps the put alive after the response returns.
      if (request.method === 'GET' && response.ok && !response.headers.has('set-cookie')) {
        ctx.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    }

    // Strip cookies so PostHog never receives first-party cookies for this domain.
    const originRequest = new Request(request);
    originRequest.headers.delete('cookie');
    return fetch(`https://${API_HOST}${url.pathname}${url.search}`, originRequest);
  },
};
