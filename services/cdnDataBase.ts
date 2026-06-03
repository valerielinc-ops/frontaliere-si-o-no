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
