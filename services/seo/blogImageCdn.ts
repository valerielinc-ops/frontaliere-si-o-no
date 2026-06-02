// blogImageCdn.ts
//
// Serve full blog hero images from jsDelivr (git-backed free CDN) instead of
// bundling them into the GitHub Pages artifact. The full images live in the
// repo at public/images/blog/*.webp (git-tracked), so jsDelivr serves them
// pinned to the build commit SHA — available immediately (the commit exists
// on GitHub before deploy) and immutably cacheable.
//
// Scope: ONLY full hero images (~224 MB) move to the CDN. The 480w responsive
// thumbnails under /images/blog/thumbnails/ are build-generated (gitignored)
// and stay same-origin — so the responsive `srcSet` keeps a local 480w entry
// and a CDN 1200w entry. A post-build plugin deletes the full images from
// dist/images/blog (keeping thumbnails) and fails the build if any full-image
// origin reference survives in the emitted HTML.
//
// Fallback: if jsDelivr is unreachable, installBlogImageCdnFallback() rewrites
// the failing <img> to raw.githubusercontent.com at the same SHA. raw serves
// images fine — its text/plain MIME + nosniff only block scripts, not images.

const REPO = 'valerielinc-ops/frontaliere-si-o-no';

// Pinned to the build commit. __COMMIT_HASH__ is injected by Vite
// (vite.config.ts define, declared in vite-env.d.ts). Falls back to the
// `main` branch ref when the hash is unavailable (e.g. dev server) — jsDelivr
// resolves @main too, only without the immutable-cache / instant-new-file
// guarantee, which dev doesn't need.
const SHA =
  typeof __COMMIT_HASH__ !== 'undefined' && __COMMIT_HASH__ && __COMMIT_HASH__ !== 'unknown'
    ? __COMMIT_HASH__
    : 'main';

export const JSDELIVR_BLOG_BASE = `https://cdn.jsdelivr.net/gh/${REPO}@${SHA}/public/images/blog`;
export const RAW_BLOG_BASE = `https://raw.githubusercontent.com/${REPO}/${SHA}/public/images/blog`;

// Full blog image at the section root (NOT under thumbnails/). Matches both a
// site-relative path and an absolute same-origin URL so callers can pass
// either `/images/blog/x.webp` or `https://host/images/blog/x.webp`.
const FULL_BLOG_RX = /^(?:https?:\/\/[^/]+)?\/images\/blog\/([^/]+\.(?:webp|png|jpe?g|avif))$/i;

/**
 * Rewrite a full blog hero image reference to its jsDelivr CDN URL.
 * Thumbnails (`/images/blog/thumbnails/...`), non-blog paths, and URLs that
 * are already absolute to another host pass through unchanged.
 */
export function cdnBlogImage(path: string | undefined | null): string {
  if (!path) return path ?? '';
  if (path.startsWith(JSDELIVR_BLOG_BASE) || path.startsWith(RAW_BLOG_BASE)) return path;
  const m = path.match(FULL_BLOG_RX);
  if (!m) return path;
  return `${JSDELIVR_BLOG_BASE}/${m[1]}`;
}

/** Map a jsDelivr blog URL to its raw.githubusercontent fallback, or null. */
export function rawFallbackForBlog(url: string): string | null {
  if (!url.startsWith(JSDELIVR_BLOG_BASE + '/')) return null;
  return RAW_BLOG_BASE + url.slice(JSDELIVR_BLOG_BASE.length);
}

let _fallbackInstalled = false;
/**
 * Install a one-time capture-phase error listener that swaps a failed jsDelivr
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
