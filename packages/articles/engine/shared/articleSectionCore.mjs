/**
 * Single source of truth for the frontaliere/svizzera article-section
 * descriptor tuple — `bodyDir` / `metaPrefix` / `registryFile` / `slugDataFile`
 * / `slugConst` / per-locale `indexSlug` (issue #4881 Fase 6, AGENTS.md #6).
 *
 * Before this module the same tuple was hand-copied in SIX places:
 *   - `services/articleSections.ts` (`ARTICLE_SECTIONS`)
 *   - `build-plugins/shared/articleSectionDescriptors.ts` (`ARTICLE_SECTION_DESCRIPTORS`)
 *   - `scripts/create-article.mjs` (`ARTICLE_SECTION_CONFIGS`)
 *   - `build-plugins/staticPagesPlugin.ts` (local `ogSections`)
 *   - `scripts/generate-rss-feeds.mjs` (`SECTIONS`)
 *   - `scripts/schedule-fb-articles-daily.mjs` (`SECTIONS`)
 * plus the localized hub-slug alternation in `scripts/lib/articleSections.mjs`
 * (`BLOG_SECTION_RX`). Each independently-maintained copy is exactly the drift
 * hazard AGENTS.md #6 forbids — a new section or a renamed slug/dir/const
 * shipped in one copy and not the others would silently desync build output,
 * RSS feeds, the FB scheduler, or the create-article CLI.
 *
 * `.mjs` (not `.ts`) so this loads unchanged in BOTH runtimes that need it:
 *   - the Vite-bundled build-plugin graph (`services/articleSections.ts`,
 *     `build-plugins/shared/articleSectionDescriptors.ts`,
 *     `build-plugins/staticPagesPlugin.ts`) — vite.config's OWN module graph
 *     can't resolve the `@/` alias for value imports, but relative imports of
 *     a plain `.mjs` work the same as any other `build-plugins/shared/*`
 *     module (see `cantonResolvers.mjs`, `viteAssetHashRx.mjs`);
 *   - raw-`node` CI scripts with no TS loader (`create-article.mjs`,
 *     `generate-rss-feeds.mjs`, `schedule-fb-articles-daily.mjs`,
 *     `scripts/lib/articleSections.mjs`).
 * Same shim-free pattern as `cantonResolvers.mjs` / `viteAssetHashRx.mjs`:
 * pure data, no `fs`/JSON import inside this file, so it has zero runtime
 * dependencies and can be imported from anywhere with a plain relative path.
 *
 * Every consumer above still owns fields that are genuinely NOT part of this
 * duplication (e.g. `seoFiles`/`canonicalPrefix`/`sitemap` in
 * `articleSectionDescriptors.ts`, or `newsSources`/`embeddingsBinPath`/
 * `sidecarDir` in `create-article.mjs`) — those stay local to each consumer.
 * Only the six fields below are the actually-duplicated tuple this module
 * collapses.
 *
 * Zero behavior change: every value here is copied byte-for-byte from the
 * pre-existing six copies (they already agreed on every value — see the
 * per-consumer equivalence tests in `tests/build-plugins/articleSectionCore.test.ts`).
 *
 * @typedef {Object} ArticleSectionLocaleSlugs
 * @property {string} it
 * @property {string} en
 * @property {string} de
 * @property {string} fr
 *
 * @typedef {Object} ArticleSectionCoreEntry
 * @property {'frontaliere' | 'svizzera'} section
 * @property {ArticleSectionLocaleSlugs} indexSlug Localized URL slug for the section hub (e.g. `articoli-frontaliere`).
 * @property {string} bodyDir Directory under `services/locales/` holding per-article body chunks (`{bodyDir}/{locale}/{articleId}.ts`).
 * @property {string} metaPrefix Filename prefix under `services/locales/` for the meta chunks (`{metaPrefix}-{locale}.ts`).
 * @property {string} registryFile Repo-relative path of the article metadata registry.
 * @property {string} slugDataFile Repo-relative path of the slug-data module read by build plugins.
 * @property {string} slugConst Name of the `const … = { … }` slug map exported by `slugDataFile` (`BLOG_SLUGS` for frontaliere, `SWISS_SLUGS` for svizzera).
 */

/** @type {Record<'frontaliere' | 'svizzera', ArticleSectionCoreEntry>} */
export const ARTICLE_SECTION_CORE = {
  frontaliere: {
    section: 'frontaliere',
    indexSlug: {
      it: 'articoli-frontaliere',
      en: 'cross-border-articles',
      de: 'grenzgaenger-artikel',
      fr: 'articles-frontalier',
    },
    bodyDir: 'blog-body',
    metaPrefix: 'blog-meta',
    registryFile: 'data/blog-articles-data.ts',
    slugDataFile: 'services/routerBlogData.ts',
    slugConst: 'BLOG_SLUGS',
  },
  svizzera: {
    section: 'svizzera',
    indexSlug: {
      it: 'articoli-svizzera',
      en: 'swiss-articles',
      de: 'schweiz-artikel',
      fr: 'articles-suisse',
    },
    bodyDir: 'blog-body-ch',
    metaPrefix: 'blog-meta-ch',
    registryFile: 'data/swiss-articles-data.ts',
    slugDataFile: 'services/routerSwissData.ts',
    slugConst: 'SWISS_SLUGS',
  },
};

/** `ARTICLE_SECTION_CORE` entries in canonical (frontaliere, svizzera) order. */
export const ARTICLE_SECTION_CORE_LIST = Object.values(ARTICLE_SECTION_CORE);
