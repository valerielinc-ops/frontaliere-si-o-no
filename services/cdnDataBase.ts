// cdnDataBase.ts
//
// Runtime CDN base for BUILD-GENERATED data files that are offloaded out of the
// GitHub Pages artifact to the orphan `cdn-assets` branch at deploy time
// (served via raw.githubusercontent — jsDelivr 502/403s on fresh orphan refs,
// see scripts/offload-generated-images-cdn.mjs).
//
// The base is injected as an inline `<script>window.__CDN_DATA_BASE__="…"</script>`
// into every dist HTML page during the post-build offload step (AFTER the orphan
// branch is pushed, when its commit SHA is known — it cannot be a Vite build-time
// define because the SHA does not exist yet at build time).
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

/** The injected raw.githubusercontent base (e.g. `https://raw.githubusercontent.com/<repo>/<sha>`), or '' when not offloaded. */
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
