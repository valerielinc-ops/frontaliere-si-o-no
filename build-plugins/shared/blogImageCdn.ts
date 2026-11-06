// blogImageCdn.ts (build-side)
//
// Build-plugin counterpart of services/seo/blogImageCdn.ts. Keep the CDN base +
// rewrite logic byte-compatible with the app-side helper so SSG-emitted URLs and
// SPA-rendered URLs match (preload/og/JSON-LD ↔ hydrated <img>). Both sides now
// pin the raw fallback to a stable `main` ref (see SHA below) — no per-build SHA.
//
// See services/seo/blogImageCdn.ts for the full rationale.

const REPO = 'valerielinc-ops/frontaliere-si-o-no';

// raw fallback ref. A stable `main` ref (no per-build commit SHA) — mirrors the
// app-side helper. Pinning to COMMIT_HASH baked a per-build value into emitted
// URLs → new content every deploy → ~100% page churn (services/seo/blogImageCdn.ts
// fixed this; this build-side gemello is aligned for consistency). The fallback
// only fires when the CDN image is briefly unreachable, and blog heroes are
// git-tracked on `main`, so a stable `main` ref recovers them fine.
const SHA = 'main';

// Full blog heroes are pushed to the frontaliere-cdn Pages site (Fastly) under
// /images/blog. STABLE URL (no SHA) — consistent with og/data/assets on the same
// CDN. The raw.githubusercontent fallback (git-tracked source @`main`) covers an
// <img> error if the CDN is briefly unreachable.
export const CDN_BLOG_BASE = `https://cdn.frontaliereticino.ch/images/blog`;
export const RAW_BLOG_BASE = `https://raw.githubusercontent.com/${REPO}/${SHA}/public/images/blog`;

// Full blog image at the section root (NOT under thumbnails/). Accepts a
// site-relative path or an absolute same-origin URL.
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
