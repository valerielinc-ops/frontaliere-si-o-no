/**
 * The robots `content` value every INDEXABLE page emitted by this package
 * must carry.
 *
 * `max-image-preview:large` is what makes a page eligible for a large-image
 * card in Google Discover and for image-rich SERP treatments. Without it the
 * crawler caps the preview at a thumbnail regardless of how good the page's
 * imagery is — and Discover is the single surface this corpus is written for.
 *
 * Why a module of its own, inside the package: `packages/articles` may not
 * import anything outside its own folder (enforced by
 * `tests/packages-articles-confinement.test.ts`), so it cannot reuse
 * `build-plugins/constants.ts`'s `ROBOTS_INDEX_ENHANCED_CONTENT`. This file
 * exists so the string is written ONCE on this side of the boundary instead of
 * hand-typed in every emitter — which is exactly how `articleHubPagesPlugin`
 * came to ship plain `index,follow` while `ogPagesPlugin` shipped the enhanced
 * directive.
 *
 * BYTE-IDENTICAL to `ROBOTS_INDEX_ENHANCED_CONTENT`, qualifier order included.
 * Not cosmetic: `renderArticleHubPages` (this package) and `emitSeoHubs`
 * (`build-plugins/seoHubsPlugin.ts`) emit the SAME article hub URLs by two
 * paths — the narrow fast-publish render and the full build — and
 * `tests/render-article-hub-pages-narrow-vs-full.test.ts` asserts their output
 * matches byte for byte. Two semantically-equivalent orderings of these five
 * qualifiers are enough to break that. `tests/seo/discover-robots-directive.ts`
 * pins the equality from the other side.
 */
export const ARTICLE_ROBOTS_INDEX_ENHANCED =
  'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
