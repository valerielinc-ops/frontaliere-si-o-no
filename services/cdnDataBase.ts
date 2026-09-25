// cdnDataBase.ts
//
// Runtime CDN base for BUILD-GENERATED data files that are offloaded out of the
// GitHub Pages artifact to the dedicated CDN repo `frontaliere-cdn` (its own
// GitHub Pages site, Fastly edge) at deploy time — served with a STABLE URL
// (CDN_BASE, no SHA pin), see scripts/offload-generated-images-cdn.mjs.
//
// The base is injected as an inline `<script>window.__CDN_DATA_BASE__="…"</script>`
// into every dist HTML page during the post-build offload step (AFTER the assets
// are pushed to the CDN repo, when CDN_BASE is known — it cannot be a Vite
// build-time define because the offload runs after the build).
//
// GRACEFUL DEGRADATION: when the base is unset (dev, or the non-fatal offload was
// skipped / failed), `cdnDataUrl` returns the original same-origin path, so the
// file is fetched from dist/ exactly as before. Callers must therefore keep
// working whether or not the offload ran.

declare global {
  interface Window {
    __CDN_DATA_BASE__?: string;
  }
}

/** The injected CDN base (e.g. `https://valerielinc-ops.github.io/frontaliere-cdn`), or '' when not offloaded. */
export function cdnDataBase(): string {
  if (typeof window === 'undefined') return '';
  const b = window.__CDN_DATA_BASE__;
  return typeof b === 'string' && b ? b : '';
}

/**
 * Resolve a same-origin generated-data path (e.g. `/data/job-detail/123.json`) to
 * its CDN URL when the file was offloaded, else return the path unchanged.
 */
export function cdnDataUrl(path: string): string {
  const base = cdnDataBase();
  return base ? base + path : path;
}

/**
 * How long a CDN data file published BETWEEN deploys may stay invisible, and
 * the resolution of its edge cache key. One object per bucket, so the CDN
 * still absorbs effectively all of the traffic.
 */
export const CDN_FRESHNESS_BUCKET_MS = 5 * 60 * 1000;

/**
 * Rotate the url of a CDN file whose CONTENT CHANGES BETWEEN DEPLOYS.
 *
 * WHY A URL AND NOT A PURGE. These files are refreshed out-of-band and their
 * publishers purge the exact url afterwards. The purge REPORTS SUCCESS and the
 * served copy does not move — measured 2026-08-06, 19 urls, HTTP 200, zero
 * effect. The responses carry `Vary: Origin`, so the edge keeps a SEPARATE
 * variant for requests that send an `Origin` header, and a cross-origin
 * `fetch()` from the app is the only caller that sends one. Cloudflare's
 * purge-by-url clears the variant matching the purge request, which carries no
 * `Origin`. The app's variant is never cleared and lives to its `max-age`.
 *
 * That asymmetry is why the defect behind issue #4974 stood for 28 hours with
 * every check green: `curl`, a direct navigation and every no-Origin CI probe
 * were served the FRESH variant, and only a browser inside the page got the
 * stale one. Measured on one url within the same second:
 *
 *   Origin sent (a browser)  → last-modified 2026-08-05T19:08:32Z
 *   no Origin  (a checker)   → last-modified 2026-08-06T07:50:46Z
 *
 * `cache: 'no-store'` does NOT help: it governs the browser's own cache, not
 * the edge's, and was verified to still return the stale variant. Only a
 * different url reaches a different cache entry.
 *
 * Use this for every CDN file a publisher rewrites between deploys.
 *
 * It does NOT reach the build artefacts (`assets/*.js`), whose URLs Vite emits
 * — and those are affected too. The post-deploy `purge_everything` does not
 * clear the browser's variant either; measured 2026-08-06 in Chrome:
 *
 *   assets/App.js   browser (Origin sent) → 2026-08-05T20:48:17Z
 *                   same URL, no Origin   → 2026-08-06T06:23:27Z
 *
 * i.e. production served a ten-hour-old bundle to real visitors while every
 * header check read current. Nothing in this file can fix that — a bundle URL
 * cannot be rotated from application code.
 *
 * That half was repaired at the edge on 2026-08-06: these responses already
 * carried a CONSTANT `Access-Control-Allow-Origin: *`, so the `Vary: Origin`
 * beside it was simply wrong — the body does not vary by origin — and a zone
 * rule (`cdn-cors-vary-fix`, http_response_headers_transform) now rewrites it
 * to `Vary: Accept-Encoding` on /assets/* and /data/*.
 *
 * No script in this repo owns that rule, so do not assume it is still there:
 * `scripts/ci/check-hydrated-article-parity.mjs` asserts the property directly
 * by fetching each surface with and without `Origin` and comparing. Keep
 * treating "deployed" and "served to browsers" as different claims.
 */
export function cdnFreshUrl(url: string, bucketMs: number = CDN_FRESHNESS_BUCKET_MS): string {
  const token = Math.floor(Date.now() / bucketMs);
  return `${url}${url.includes('?') ? '&' : '?'}v=${token}`;
}
