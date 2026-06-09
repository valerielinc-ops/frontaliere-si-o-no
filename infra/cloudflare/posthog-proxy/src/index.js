// First-party reverse proxy for PostHog EU Cloud.
//
// Served on https://t.frontaliereticino.ch (Cloudflare Worker custom domain) so
// analytics requests are same-origin and bypass ad-blockers that block
// *.posthog.com. The client points `api_host` at this domain (see
// services/posthog.ts). Without this proxy the host is NXDOMAIN and every
// PostHog event fails (observed 2026-06-09).
//
//   /static/*  -> eu-assets.i.posthog.com   (posthog-js bundle, cacheable)
//   everything -> eu.i.posthog.com          (event ingestion / flags / etc.)
const API_HOST = 'eu.i.posthog.com';
const ASSET_HOST = 'eu-assets.i.posthog.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/static/')) {
      const cache = caches.default;
      let response = await cache.match(request);
      if (!response) {
        response = await fetch(`https://${ASSET_HOST}${url.pathname}${url.search}`, {
          headers: request.headers,
        });
      }
      return response;
    }

    // Strip cookies so PostHog never receives first-party cookies for this domain.
    const originRequest = new Request(request);
    originRequest.headers.delete('cookie');
    return fetch(`https://${API_HOST}${url.pathname}${url.search}`, originRequest);
  },
};
