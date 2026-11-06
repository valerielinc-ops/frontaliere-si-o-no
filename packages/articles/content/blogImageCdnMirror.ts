// blogImageCdnMirror.ts (packages/articles content-side)
//
// Package-side twin of `services/seo/blogImageCdn.ts` and its existing
// build-side gemello `build-plugins/shared/blogImageCdn.ts` (that duplication
// predates this file and is a deliberate, documented exception to AGENTS.md
// #6's "extract shared module" rule — the two live in different Vite config
// graphs that cannot import each other, see that file's own header). This is
// a THIRD, byte-compatible copy for the same reason: `packages/articles`
// cannot import `services/seo/blogImageCdn.ts` without crossing the package's
// confinement boundary (content/blog-articles-data.ts and
// content/swiss-articles-data.ts need `cdnBlogImage` but must not reach
// outside `packages/articles`).
//
// Keep all three byte-compatible. See `services/seo/blogImageCdn.ts` for the
// full rationale on the CDN base + raw-fallback logic.

const REPO = 'valerielinc-ops/frontaliere-si-o-no';

// Stable `main` ref (no per-build commit SHA) — mirrors both existing twins.
const SHA = 'main';

export const CDN_BLOG_BASE = `https://cdn.frontaliereticino.ch/images/blog`;
export const RAW_BLOG_BASE = `https://raw.githubusercontent.com/${REPO}/${SHA}/public/images/blog`;

const FULL_BLOG_RX = /^(?:https?:\/\/[^/]+)?\/images\/blog\/([^/]+\.(?:webp|png|jpe?g|avif))$/i;

/**
 * Rewrite a full blog hero image reference to its CDN URL.
 * Thumbnails (`/images/blog/thumbnails/...`) and non-blog paths pass through.
 */
export function cdnBlogImage(path: string | undefined | null): string {
  if (!path) return path ?? '';
  if (path.startsWith(CDN_BLOG_BASE) || path.startsWith(RAW_BLOG_BASE)) return path;
  const m = path.match(FULL_BLOG_RX);
  if (!m) return path;
  return `${CDN_BLOG_BASE}/${m[1]}`;
}
