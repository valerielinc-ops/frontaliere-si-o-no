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
 *   - `packages/articles/engine/rssFeeds.mjs` (`RSS_SECTIONS`, was
 *     `scripts/generate-rss-feeds.mjs` before #4974 item 2)
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
 *     `rssFeeds.mjs`, `schedule-fb-articles-daily.mjs`,
 *     `scripts/lib/articleSections.mjs`).
 * Same shim-free pattern as `cantonResolvers.mjs` / `viteAssetHashRx.mjs`:
 * pure data, no `fs`/JSON import inside this file, so it has zero runtime
 * dependencies and can be imported from anywhere with a plain relative path.
 * Its only import is the sibling `cantonArticleSectionCore.generated.mjs`,
 * equally pure (generated from `data/canton-url-slugs.json` by
 * `scripts/generate-canton-article-sections.mjs`, so no JSON is read here).
 *
 * Every consumer above still owns fields that are genuinely NOT part of this
 * duplication (e.g. `seoFiles`/`canonicalPrefix`/`sitemap` in
 * `articleSectionDescriptors.ts`, or `newsSources`/`embeddingsBinPath`/
 * `sidecarDir` in `create-article.mjs`) — those stay local to each consumer.
 * Only the six fields below are the actually-duplicated tuple this module
 * collapses.
 *
 * ── Table-driven sections (canton sections, piano «sezioni cantonali» S1) ──
 * Each entry also carries `kind` (`frontaliere` | `national` | `canton`) and
 * `shardKey`: engine branches look the kind up instead of comparing the
 * section NAME, so a new section is a data row, not a new `if`. The 24 canton
 * entries live in `ARTICLE_SECTION_CORE_ALL` but are INACTIVE:
 * `ARTICLE_SECTION_CORE` / `ARTICLE_SECTION_CORE_LIST` hold only the active
 * sections (today frontaliere and svizzera), so every consumer that iterates
 * them — here and in the corpus repo after the engine mirror — emits exactly
 * what it emitted before.
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
 * @typedef {'frontaliere' | 'national' | 'canton'} ArticleSectionKind
 *
 * @typedef {Object} ArticleSectionCoreEntry
 * @property {string} section Section id: `frontaliere`, `svizzera` or `canton-<code>` (e.g. `canton-ti`).
 * @property {ArticleSectionKind} kind Editorial family. `frontaliere` = the cross-border section, `national` = the Switzerland-wide section, `canton` = one canton URL group. Every branch that used to compare the section NAME (`=== 'svizzera'`) reads this instead.
 * @property {string | null} shardKey Pages-shard token serving the section (`articolifrontaliere` → `frontaliere-articolifrontaliere-<loc>`). `null` for canton sections, served from R2 + Worker instead of a Pages shard.
 * @property {ArticleSectionLocaleSlugs} indexSlug Localized URL slug for the section hub (e.g. `articoli-frontaliere`).
 * @property {string} bodyDir Directory under `services/locales/` holding per-article body chunks (`{bodyDir}/{locale}/{articleId}.ts`).
 * @property {string} metaPrefix Filename prefix under `services/locales/` for the meta chunks (`{metaPrefix}-{locale}.ts`).
 * @property {string} registryFile Repo-relative path of the article metadata registry.
 * @property {string} slugDataFile Repo-relative path of the slug-data module read by build plugins.
 * @property {string} slugConst Name of the `const … = { … }` slug map exported by `slugDataFile` (`BLOG_SLUGS` for frontaliere, `SWISS_SLUGS` for svizzera, `CANTON_SLUGS` for every canton section).
 * @property {string} [canton] Canton URL-group code (`TI`, `BASILEA`, …). Canton sections only.
 * @property {Record<string, ArticleSectionLocaleSlugs>} [topicHubs] Reserved localized slugs of the section's topic hubs (theme id → slug per locale). Canton sections only.
 */

import {
  ACTIVE_CANTON_SECTIONS,
  CANTON_ARTICLE_SECTION_CORE,
  CANTON_HUB_TOPIC_KEYS,
} from './cantonArticleSectionCore.generated.mjs';

/** Every kind a section can declare, in canonical order. */
export const ARTICLE_SECTION_KINDS = ['frontaliere', 'national', 'canton'];

/**
 * The two historical sections. Hand-written: svizzera's slugs do not follow
 * the canton formula (`swiss-articles`, not `switzerland-articles`).
 * @type {Record<'frontaliere' | 'svizzera', ArticleSectionCoreEntry>}
 */
const HISTORICAL_ARTICLE_SECTION_CORE = {
  frontaliere: {
    section: 'frontaliere',
    kind: 'frontaliere',
    shardKey: 'articolifrontaliere',
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
    kind: 'national',
    shardKey: 'articolisvizzera',
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

/**
 * EVERY known section, active or not: the 2 historical ones followed by the
 * 24 canton URL groups generated from `data/canton-url-slugs.json`
 * (`cantonArticleSectionCore.generated.mjs`). Use it for lookups by id
 * (`articleSectionKind`, `cantonHubTopicSlugs`) and for collision checks —
 * never to decide what to build or publish.
 * @type {Record<string, ArticleSectionCoreEntry>}
 */
export const ARTICLE_SECTION_CORE_ALL = {
  ...HISTORICAL_ARTICLE_SECTION_CORE,
  ...CANTON_ARTICLE_SECTION_CORE,
};

/**
 * The ACTIVE sections: frontaliere, svizzera, then each canton listed in
 * `ACTIVE_CANTON_SECTIONS` (empty today). Every consumer that iterates the
 * sections — build plugins, RSS, the corpus publisher, create-article — reads
 * this map or `ARTICLE_SECTION_CORE_LIST`, so adding the 24 inactive canton
 * entries above changes nothing they emit. Same entry objects as
 * `ARTICLE_SECTION_CORE_ALL` (reference-equal), never copies.
 * @type {Record<string, ArticleSectionCoreEntry>}
 */
export const ARTICLE_SECTION_CORE = {
  ...HISTORICAL_ARTICLE_SECTION_CORE,
  ...Object.fromEntries(ACTIVE_CANTON_SECTIONS.map((id) => {
    const entry = CANTON_ARTICLE_SECTION_CORE[id];
    if (!entry) throw new Error(`ACTIVE_CANTON_SECTIONS: sezione cantonale sconosciuta "${id}"`);
    return [id, entry];
  })),
};

/** Active `ARTICLE_SECTION_CORE` entries in canonical order (frontaliere, svizzera, active cantons). */
export const ARTICLE_SECTION_CORE_LIST = Object.values(ARTICLE_SECTION_CORE);

/**
 * Entry for any known section id, active or not. Throws on an unknown id:
 * a typo must not silently fall back to another section's slugs or copy.
 * @param {string} id
 * @returns {ArticleSectionCoreEntry}
 */
export function articleSectionEntry(id) {
  const entry = Object.prototype.hasOwnProperty.call(ARTICLE_SECTION_CORE_ALL, id) ? ARTICLE_SECTION_CORE_ALL[id] : undefined;
  if (!entry) throw new Error(`sezione articoli sconosciuta: "${id}"`);
  return entry;
}

/**
 * Kind of any known section id (throws on an unknown id).
 * @param {string} id
 * @returns {ArticleSectionKind}
 */
export function articleSectionKind(id) {
  return articleSectionEntry(id).kind;
}

/**
 * ACTIVE sections of one kind, in canonical order. `sectionsOfKind('canton')`
 * is `[]` until a canton is listed in `ACTIVE_CANTON_SECTIONS`.
 * @param {ArticleSectionKind} kind
 * @returns {ArticleSectionCoreEntry[]}
 */
export function sectionsOfKind(kind) {
  if (!ARTICLE_SECTION_KINDS.includes(kind)) throw new Error(`tipo di sezione sconosciuto: "${kind}"`);
  return ARTICLE_SECTION_CORE_LIST.filter((entry) => entry.kind === kind);
}

/**
 * True for a canton section id (`canton-ti`, …), active or not.
 * @param {string} id
 * @returns {boolean}
 */
export function isCantonSection(id) {
  return Object.prototype.hasOwnProperty.call(CANTON_ARTICLE_SECTION_CORE, id);
}

/**
 * The section an archive cross-links to as its "see also" sibling. Was the
 * ternary `section === 'frontaliere' ? 'svizzera' : 'frontaliere'`: the
 * frontaliere and national sections point at each other; a canton section
 * points at the national one (its parent scope).
 * @param {string} id
 * @returns {'frontaliere' | 'svizzera'}
 */
export function twinOf(id) {
  switch (articleSectionKind(id)) {
    case 'frontaliere':
      return 'svizzera';
    case 'national':
      return 'frontaliere';
    case 'canton':
      return 'svizzera';
    default:
      throw new Error(`twinOf: tipo di sezione non gestito per "${id}"`);
  }
}

/**
 * Reserved topic-hub slugs of a canton section for one locale, in canonical
 * theme order (carburanti, fisco, mobilita, eventi, pensioni, servizi).
 * Throws for a non-canton section: only canton sections own these hubs.
 * @param {string} section
 * @param {'it' | 'en' | 'de' | 'fr'} locale
 * @returns {string[]}
 */
export function cantonHubTopicSlugs(section, locale) {
  if (!isCantonSection(section)) throw new Error(`cantonHubTopicSlugs: "${section}" non e' una sezione cantonale`);
  const hubs = CANTON_ARTICLE_SECTION_CORE[section].topicHubs;
  return CANTON_HUB_TOPIC_KEYS.map((key) => {
    const slug = hubs[key]?.[locale];
    if (typeof slug !== 'string') throw new Error(`cantonHubTopicSlugs: slug ${locale} mancante per il tema "${key}"`);
    return slug;
  });
}
