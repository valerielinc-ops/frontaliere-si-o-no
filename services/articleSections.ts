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
 * Keeping this config in one place means a new section is mostly data, and the
 * existing frontaliere behaviour stays byte-identical (it is the default).
 */
import type { Locale } from './i18n';

export type ArticleSection = 'frontaliere' | 'svizzera';

export const DEFAULT_ARTICLE_SECTION: ArticleSection = 'frontaliere';

export interface ArticleSectionConfig {
  readonly section: ArticleSection;
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
}

export const ARTICLE_SECTIONS: Record<ArticleSection, ArticleSectionConfig> = {
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
  },
};

export const ARTICLE_SECTION_LIST: readonly ArticleSectionConfig[] =
  Object.values(ARTICLE_SECTIONS);

/** All four localized hub slugs across both sections (for route detection). */
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
