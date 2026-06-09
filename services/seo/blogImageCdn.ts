// blogImageCdn.ts
//
// Serve full blog hero images from the frontaliere-cdn GitHub Pages site (Fastly
// edge) on cdn.frontaliereticino.ch instead of bundling them into the main
// GitHub Pages artifact. The full images live in the repo at
// public/images/blog/*.webp (git-tracked); the deploy workflow pushes them to
// the CDN repo under /images/blog, served at a STABLE URL — consistent with
// og/data/assets, all on the one CDN (no jsDelivr).
//
// Scope: full hero images (~224 MB) AND the 480w responsive thumbnails (~49 MB)
// move to the CDN. The thumbnails are build-generated (gitignored) under
// /images/blog/thumbnails/; getResponsiveImageSet (components/community/
// BlogArticles.tsx) emits the CDN thumbnail URL so the responsive `srcSet` is a
// CDN 480w + CDN 1200w pair, and scripts/offload-generated-images-cdn.mjs deletes
// dist/images/blog/thumbnails after the deploy pushes them to the CDN. A
// post-build plugin (blogImageCdnFinalizePlugin) deletes the full images from
// dist/images/blog — keeping the thumbnails/ subdir for that offload step to push
// and delete — and fails the build if any full-image origin ref survives in HTML.
//
// Fallback: if the CDN is briefly unreachable, installBlogImageCdnFallback()
// rewrites the failing <img> to raw.githubusercontent.com at the build SHA
// (git-tracked source). raw serves images fine — its text/plain MIME + nosniff
// only block scripts, not images. NOTE: thumbnails have NO raw copy (gitignored),
// so rawFallbackForBlog() returns null for /thumbnails/ URLs — the cleared srcSet
// then degrades to the full CDN hero, which DOES recover on raw during an outage.

const REPO = 'valerielinc-ops/frontaliere-si-o-no';

// raw fallback ref. Previously pinned to the build commit via the __COMMIT_HASH__
// Vite define, but that baked a per-build value into the SPA entry chunk → new
// entry content hash every deploy → ~100% page churn (the entry filename is
// referenced by every prerendered page). The raw fallback only fires when the
// CDN image is briefly unreachable (rare), and the blog hero images are
// git-tracked on `main`, so a stable `main` ref recovers them just fine without
// making the bundle non-deterministic. The primary CDN base has no SHA — it's a
// stable domain whose Fastly cache is purged on each CDN-repo deploy.
const SHA = 'main';

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
  // 480w thumbnails are build-generated (gitignored) — they have NO raw.github
  // copy, so there is nothing to fall back to. Returning null here also keeps the
  // one-shot `cdnFallback` flag UNSET on the thumbnail <img>, so that when the
  // cleared srcSet falls back to the full hero (git-tracked → raw exists) the
  // capture listener fires again and recovers the hero on raw during a CDN outage.
  if (url.includes('/thumbnails/')) return null;
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
