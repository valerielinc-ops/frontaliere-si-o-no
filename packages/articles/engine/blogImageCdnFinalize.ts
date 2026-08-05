/**
 * Hero-image CDN rewrite (fast-publish step 5).
 *
 * Rewrites same-origin `/images/blog/<file>` references to their CDN URL, on
 * every file the fast path writes (article index + flat bridge), matching
 * `blogImageCdnFinalizePlugin`'s unconditional whole-dist walk in the full
 * build.
 *
 * Transported for issue #4974 item 3 (migration §10.4 step 2) BY FUNCTION
 * CLOSURE from `build-plugins/blogImageCdnFinalizePlugin.ts` (176 lines) plus
 * `CDN_BLOG_BASE` from `build-plugins/shared/blogImageCdn.ts`. The Vite plugin
 * wrapper stays in the host.
 *
 * SINGLE PRODUCER: the host's `build-plugins/blogImageCdnFinalizePlugin.ts`
 * re-exports these.
 */


// Full blog heroes are pushed to the frontaliere-cdn Pages site (Fastly) under
// /images/blog. STABLE URL (no SHA) — consistent with og/data/assets on the same
// CDN. The raw.githubusercontent fallback (git-tracked source @`main`) covers an
// <img> error if the CDN is briefly unreachable.
export const CDN_BLOG_BASE = `https://cdn.frontaliereticino.ch/images/blog`;

const ORIGIN = 'https://frontaliereticino.ch';

// A FULL blog image: `/images/blog/<file>.<ext>` with no further path segment
// (so `/images/blog/thumbnails/...` never matches — it has an extra `/`).
const FILE = "([^\"'\\s/?)]+?\\.(?:webp|png|jpe?g|avif))";

const ESC_ORIGIN = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrite targets: origin-absolute, and site-relative NOT preceded by a word
// char. The `(?<![\w.@])` guard means CDN/raw URLs (`…/public/images/blog/…`,
// the `c` of `public` is a word char) are never matched — they're left intact.
const reAbs = new RegExp(ESC_ORIGIN + '/images/blog/' + FILE, 'g');

const reRel = new RegExp('(?<![\\w.@])/images/blog/' + FILE, 'g');

// Guard: a SURVIVING full-blog reference that would 404 once the dir is gone —
// origin-absolute, or relative not preceded by a word char (so `/public/images/
// blog/…` inside an emitted CDN/raw URL is excluded), excluding thumbnails.
const reLeak = new RegExp(
  '(?:' + ESC_ORIGIN + '/images/blog/|(?<![\\w.@])/images/blog/)(?!thumbnails/)' + FILE,
);

/**
 * Rewrite every same-origin reference to a FULL blog hero image
 * (`/images/blog/<file>.<ext>`, origin-absolute or site-relative) to its CDN
 * URL. Pure string transform, no filesystem I/O — extracted (#4837 stream A)
 * so the standalone single-article fast-publish script
 * (scripts/publish-article-fast.mjs) can apply the IDENTICAL rewrite to a
 * freshly-rendered page without needing the physical dist/images/blog
 * directory to exist (this plugin's closeBundle guards on that directory,
 * which a scratch single-article render never has). Do not fork this — any
 * fix here must benefit both the full build and the fast path.
 */
export function rewriteBlogImageRefs(html: string): string {
  const repl = (_m: string, file: string): string => `${CDN_BLOG_BASE}/${file}`;
  return html.replace(reAbs, repl).replace(reRel, repl);
}

/** True when `html` still references a full (non-thumbnail, non-CDN) blog image after rewriteBlogImageRefs. */
export function hasBlogImageLeak(html: string): boolean {
  return reLeak.test(html);
}
