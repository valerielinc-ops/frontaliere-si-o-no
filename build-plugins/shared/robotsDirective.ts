/**
 * The `content` value every INDEXABLE page must carry.
 *
 * `max-image-preview:large` is the gate Google applies before a page is
 * eligible for a large-image card in Discover and in image-rich SERP
 * treatments — without it the preview is capped at a thumbnail regardless of
 * how good the page's imagery is.
 *
 * Split into its own Node-import-free module (rather than living directly in
 * `build-plugins/constants.ts`, which pulls in `node:fs`/`node:child_process`
 * at module scope) so client bundle code can import the SAME string instead
 * of hand-typing another copy. `services/seoService.ts` (client-side runtime
 * meta-tag updates) previously carried its own hand-typed copy with the
 * qualifiers in a different order than this one — same value, invisible to
 * crawlers, but exactly the kind of drift that breaks byte-identity
 * comparisons elsewhere in the build (issue #5494).
 *
 * `build-plugins/constants.ts` re-exports this under the same name so its
 * existing call sites are unaffected. `packages/articles/engine` keeps its
 * OWN confined copy (`ARTICLE_ROBOTS_INDEX_ENHANCED`) because that package may
 * not import outside its folder — see that file's docblock.
 */
export const ROBOTS_INDEX_ENHANCED_CONTENT =
  'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
