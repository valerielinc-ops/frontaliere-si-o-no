/**
 * @frontaliereticino/articles — public API (issue #4881 Fase 6, Step 3).
 *
 * This is the ONLY module external consumers (the main repo today, a
 * standalone `npm install github:...` consumer after Fase 6 Step 4) should
 * import from. Reaching past this file into `engine/`, `content/`, or
 * `articleSections.ts` directly is unsupported — those paths may be
 * reorganized without notice; this barrel's exported names are the contract.
 *
 * Before calling any render/plugin function exported here, the host
 * application MUST call `configureSiteShell(contract)` once with a real
 * `SiteShellContract` (chunk names, CSS href, header/footer chrome, locale
 * strings, base URL, meta-description budget, SPA bundle info — see
 * `./engine/siteShell.ts`). In this repo that wiring lives in
 * `build-plugins/articlesSiteShellBootstrap.ts`; every pre-existing
 * old-path import (`build-plugins/ogPagesPlugin.ts`, etc.) triggers it as a
 * side effect, so nothing else needs to change. A new consumer that imports
 * this package directly must import/run that wiring itself first.
 */

// ── Site-shell contract ──────────────────────────────────────────────────
// The boundary: types + configureSiteShell/getSiteShell/resetSiteShellForTests.
export * from './engine/siteShell';

// ── Rendering engine (Vite plugins + the functions they wrap) ───────────
export * from './engine/ogPagesPlugin';
export * from './engine/blogContextualLinksPlugin';
export * from './engine/articleSeoFallback';
export * from './engine/newsTickerDataPlugin';

// ── Engine-internal shared helpers, also consumed directly by main-repo
// build plugins (staticPagesPlugin.ts, sectionPagesPlugin.ts, etc.) ──────
export * from './engine/shared/articleArchiveUnion';
export * from './engine/shared/ctrBoostDescription';
export * from './engine/shared/articleReaders';
export * from './engine/shared/articleSectionDescriptors';
export * from './engine/shared/faqQuestionPrefixes';
export * from './engine/shared/stripMarkdownPlain';
export * from './engine/shared/swissArticleCanonicalOverrides';

// ── Article content + slug/id registries ────────────────────────────────
// content/blog-articles-data.ts declares `Article`; swiss-articles-data.ts
// only re-exports that same type (`export type { Article }`) for its own
// old-path consumers — re-exporting it a second time here would collide, so
// only its own new export (SWISS_ARTICLES) is named explicitly.
export * from './content/blog-articles-data';
export { SWISS_ARTICLES } from './content/swiss-articles-data';
export * from './articleSections';
export * from './content/routerBlogData';
export * from './content/routerSwissData';
