/**
 * Shared "core" sub-sitemap filename list.
 *
 * Extracted because scripts/submit-indexnow.js and
 * scripts/submit-google-indexing.js each hardcoded the EXACT SAME array
 * (issue #4837 stream D, defect 1) — and both copies were missing
 * `sitemap-blog-ch.xml` (the svizzera-article sub-sitemap, emitted by
 * build-plugins/ogPagesPlugin.ts), so svizzera articles were silently never
 * submitted to IndexNow or re-pinged to Google's Indexing API. A single
 * shared source makes that class of drift impossible by construction.
 *
 * `sitemap-news.xml` is deliberately NOT included here — callers that need
 * it compose `[...CORE_SITEMAPS, 'sitemap-news.xml']` themselves, since it's
 * read on a different cadence/path (chronological last-N items) than these.
 */
export const CORE_SITEMAPS = [
  'sitemap-pages.xml',
  'sitemap-blog.xml',
  'sitemap-blog-ch.xml',
  'sitemap-glossario.xml',
  'sitemap-jobs.xml',
  'sitemap-seo-hubs.xml',
];
