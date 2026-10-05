/**
 * Article-section registry — single source of truth for the two parallel
 * article hubs: the original cross-border ("frontaliere") section and the
 * Switzerland-wide ("svizzera") mirror section.
 *
 * Both sections share the same runtime component, i18n key namespace
 * (`blog.article.{id}.*`) and SEO key namespace (`blog-{id}`). Because those
 * namespaces are shared, article ids MUST be unique across sections — a
 * collision would let one section's entry silently override the other's
 * canonical / structured-data. This is enforced at generation time:
 * `scripts/create-article.mjs` dedups a new id against the ids of ALL sections
 * (see `getSectionExistingIds`), not just the section being written. They differ
 * only in: localized URL hub slug, per-article body directory, meta-chunk
 * filename prefix, and the article registry / slug-data they read from.
 *
 * The actual field values (`indexSlug`/`bodyDir`/`metaPrefix`/`registryFile`/
 * `slugDataFile`/`slugConst`) live in `build-plugins/shared/articleSectionCore.mjs`
 * — the single canonical copy shared with the build-plugin graph and the raw
 * Node CI scripts that need the same tuple (issue #4881 Fase 6). This module
 * re-exports that core with the richer TS types the rest of the app graph
 * expects, plus the derived helpers below (`allArticleHubSlugs`,
 * `sectionForHubSlug`). Do not hand-edit `ARTICLE_SECTIONS` here — edit the
 * `.mjs` core instead, this file just types and re-exports it.
 */
import type { ArticleLocale as Locale } from './engine/siteShell';
import { ARTICLE_SECTION_CORE } from './engine/shared/articleSectionCore.mjs';

/** The two historical sections, always active. */
export type HistoricalArticleSection = 'frontaliere' | 'svizzera';

/**
 * Canton section ids (`canton-ti`, `canton-basilea`, …), generated from
 * `data/canton-url-slugs.json` into `engine/shared/cantonArticleSectionCore.generated.mjs`.
 * Open on purpose: the closed set lives in the generated data, not in a type
 * someone has to keep in step with it.
 */
export type CantonArticleSection = `canton-${string}`;

/**
 * Any article section id. Open (was the closed `'frontaliere' | 'svizzera'`)
 * so table-driven code can name a canton section; which sections are ACTIVE
 * is data (`ARTICLE_SECTIONS`), not this type.
 */
export type ArticleSection = HistoricalArticleSection | CantonArticleSection;

/** Editorial family of a section — what engine branches look up instead of the section name. */
export type ArticleSectionKind = 'frontaliere' | 'national' | 'canton';

export const DEFAULT_ARTICLE_SECTION: ArticleSection = 'frontaliere';

export interface ArticleSectionConfig {
  readonly section: ArticleSection;
  /** Editorial family (`frontaliere` | `national` | `canton`). */
  readonly kind: ArticleSectionKind;
  /**
   * Pages-shard token serving the section (`articolifrontaliere`,
   * `articolisvizzera`); `null` for canton sections, served from R2.
   */
  readonly shardKey: string | null;
  /** Canton URL-group code (`TI`, `BASILEA`, …). Canton sections only. */
  readonly canton?: string;
  /** Reserved topic-hub slugs (theme id → slug per locale). Canton sections only. */
  readonly topicHubs?: Readonly<Record<string, Record<Locale, string>>>;
  /** Localized URL slug for the section hub (e.g. `articoli-frontaliere`). */
  readonly indexSlug: Record<Locale, string>;
  /**
   * Directory under `services/locales/` holding per-article body chunks
   * (`{bodyDir}/{locale}/{articleId}.ts`).
   */
  readonly bodyDir: string;
  /**
   * Filename prefix under `services/locales/` for the meta chunks
   * (`{metaPrefix}-{locale}.ts`).
   */
  readonly metaPrefix: string;
  /** Repo-relative path of the article metadata registry. */
  readonly registryFile: string;
  /** Repo-relative path of the slug-data module read by build plugins. */
  readonly slugDataFile: string;
  /**
   * Name of the `const … = { … }` slug map exported by {@link slugDataFile}
   * (`BLOG_SLUGS` for frontaliere, `SWISS_SLUGS` for svizzera). Build plugins
   * parse this block to map `BlogArticleId → per-locale URL slug`.
   */
  readonly slugConst: string;
}

/**
 * ACTIVE sections only (today frontaliere + svizzera; a canton joins when it
 * is listed in `ACTIVE_CANTON_SECTIONS`). The historical keys are always
 * present, so `ARTICLE_SECTIONS.svizzera` stays a non-optional lookup.
 */
export const ARTICLE_SECTIONS: Record<ArticleSection, ArticleSectionConfig> =
  ARTICLE_SECTION_CORE as unknown as Record<ArticleSection, ArticleSectionConfig>;

export const ARTICLE_SECTION_LIST: readonly ArticleSectionConfig[] =
  Object.values(ARTICLE_SECTIONS);

/**
 * Config of an ACTIVE section, failing loudly otherwise. `ArticleSection`
 * admits every `canton-*` id while only the active ones are in
 * `ARTICLE_SECTIONS`; an inactive id must not read as `undefined` fields.
 */
export function activeArticleSection(section: ArticleSection): ArticleSectionConfig {
  const cfg = Object.prototype.hasOwnProperty.call(ARTICLE_SECTIONS, section) ? ARTICLE_SECTIONS[section] : undefined;
  if (!cfg) throw new Error(`sezione articoli non attiva: "${section}"`);
  return cfg;
}

/** All four localized hub slugs across the active sections (for route detection). */
export function allArticleHubSlugs(): string[] {
  const slugs: string[] = [];
  for (const cfg of ARTICLE_SECTION_LIST) {
    for (const locale of Object.keys(cfg.indexSlug) as Locale[]) {
      slugs.push(cfg.indexSlug[locale]);
    }
  }
  return slugs;
}

/** Resolve which section a hub slug belongs to (any locale). */
export function sectionForHubSlug(slug: string): ArticleSection | undefined {
  for (const cfg of ARTICLE_SECTION_LIST) {
    for (const locale of Object.keys(cfg.indexSlug) as Locale[]) {
      if (cfg.indexSlug[locale] === slug) return cfg.section;
    }
  }
  return undefined;
}
