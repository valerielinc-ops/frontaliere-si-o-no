// blogImageCdn.ts
//
// Serve full blog hero images from the frontaliere-cdn GitHub Pages site (Fastly
// edge) on cdn.frontaliereticino.ch instead of bundling them into the main
// GitHub Pages artifact. The full images live in the repo at
// public/images/blog/*.webp (git-tracked); the deploy workflow pushes them to
// the CDN repo under /images/blog, served at a STABLE URL — consistent with
// og/data/assets, all on the one CDN (no jsDelivr).
//
// Scope: ONLY full hero images (~224 MB) move to the CDN. The 480w responsive
// thumbnails under /images/blog/thumbnails/ are build-generated (gitignored)
// and stay same-origin — so the responsive `srcSet` keeps a local 480w entry
// and a CDN 1200w entry. A post-build plugin deletes the full images from
// dist/images/blog (keeping thumbnails) and fails the build if any full-image
// origin reference survives in the emitted HTML.
//
// Fallback: if the CDN is briefly unreachable, installBlogImageCdnFallback()
// rewrites the failing <img> to raw.githubusercontent.com at the build SHA
// (git-tracked source). raw serves images fine — its text/plain MIME + nosniff
// only block scripts, not images.

const REPO = 'valerielinc-ops/frontaliere-si-o-no';

// raw fallback is pinned to the build commit. __COMMIT_HASH__ is injected by
// Vite (vite.config.ts define, declared in vite-env.d.ts); falls back to `main`
// when unavailable (e.g. dev server). The primary CDN base has no SHA — it's a
// stable domain whose Fastly cache is purged on each CDN-repo deploy.
const SHA =
  typeof __COMMIT_HASH__ !== 'undefined' && __COMMIT_HASH__ && __COMMIT_HASH__ !== 'unknown'
    ? __COMMIT_HASH__
    : 'main';

export const CDN_BLOG_BASE = `https://cdn.frontaliereticino.ch/images/blog`;
export const RAW_BLOG_BASE = `https://raw.githubusercontent.com/${REPO}/${SHA}/public/images/blog`;

// Full blog image at the section root (NOT under thumbnails/). Matches both a
// site-relative path and an absolute same-origin URL so callers can pass
// either `/images/blog/x.webp` or `https://host/images/blog/x.webp`.
const FULL_BLOG_RX = /^(?:https?:\/\/[^/]+)?\/images\/blog\/([^/]+\.(?:webp|png|jpe?g|avif))$/i;

/**
 * Rewrite a full blog hero image reference to its CDN URL (cdn.frontaliereticino.ch).
 * Thumbnails (`/images/blog/thumbnails/...`), non-blog paths, and URLs that
 * are already absolute to another host pass through unchanged.
 */
export function cdnBlogImage(path: string | undefined | null): string {
  if (!path) return path ?? '';
  if (path.startsWith(CDN_BLOG_BASE) || path.startsWith(RAW_BLOG_BASE)) return path;
  const m = path.match(FULL_BLOG_RX);
  if (!m) return path;
  return `${CDN_BLOG_BASE}/${m[1]}`;
}

/** Map a CDN blog URL to its raw.githubusercontent fallback, or null. */
export function rawFallbackForBlog(url: string): string | null {
  if (!url.startsWith(CDN_BLOG_BASE + '/')) return null;
  return RAW_BLOG_BASE + url.slice(CDN_BLOG_BASE.length);
}

let _fallbackInstalled = false;
/**
 * Install a one-time capture-phase error listener that swaps a failed CDN
 * blog image to its raw.githubusercontent fallback. Image `error` events don't
 * bubble, so capture phase is required to catch them at the document level.
 */
export function installBlogImageCdnFallback(): void {
  if (_fallbackInstalled || typeof document === 'undefined') return;
  _fallbackInstalled = true;
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target as HTMLImageElement | null;
      if (!t || t.tagName !== 'IMG' || t.dataset.cdnFallback) return;
      const raw = rawFallbackForBlog(t.currentSrc || t.src);
      if (!raw) return;
      t.dataset.cdnFallback = '1';
      if (t.srcset) t.srcset = '';
      t.src = raw;
    },
    true,
  );
}
