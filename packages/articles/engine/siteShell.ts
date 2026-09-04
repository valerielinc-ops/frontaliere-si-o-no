/**
 * SiteShellContract — the ONLY door between the `packages/articles` engine
 * and the site it renders into.
 *
 * `packages/articles` owns article content + rendering. It knows nothing
 * about the host site's chunk names, CSS, header/footer chrome, locale
 * strings, or base URL — those are supplied by whoever embeds the package,
 * through this contract, instead of the engine reaching out via relative
 * imports into `../services/*` / `../build-plugins/*`.
 *
 * Every field's shape here is deliberately a MINIMAL structural type — only
 * the properties the engine actually reads — not an import of the site's own
 * (richer) type. That is what makes this file confinement-clean: it never
 * imports anything from outside `packages/articles`, yet still gets full
 * type safety, because TypeScript structural typing lets the site's real,
 * richer values satisfy these narrower shapes at the wiring point (see
 * `build-plugins/articlesSiteShellBootstrap.ts` in the main repo, which is
 * NOT part of this package and is where the real value imports happen).
 *
 * Call `configureSiteShell(...)` once before any render function in this
 * package runs (`ogPagesPlugin`, `blogContextualLinksPlugin`,
 * `articleSeoFallback`, `newsTickerDataPlugin`, `articleArchiveUnion` all
 * read it via `getSiteShell()`). Every old-path shim left behind by the
 * Fase 6 colocation move imports the bootstrap as a side effect, so any
 * existing consumer keeps working without changes.
 */

export type ArticleLocale = 'it' | 'en' | 'de' | 'fr';

export interface ArticleAuthorSocial {
  linkedin?: string;
}

export interface ArticleAuthor {
  slug: string;
  name: string;
  role: string;
  social?: ArticleAuthorSocial;
}

export interface ArticleImageObjectInput {
  contentUrl?: string;
  url?: string;
  caption?: string;
  width?: number | string;
  height?: number | string;
  datePublished?: string;
  inLanguage?: string;
  // Mirrors `services/seo/imageObjectLd.ts`'s `ImageCreator` union
  // (`OrganizationCreator | PersonCreator`) structurally — narrow enough for
  // the real function's parameter to satisfy this shape (a plain
  // `Record<string, unknown>` here would NOT typecheck against that union).
  creator?: { '@type': 'Organization' | 'Person'; name: string; url?: string };
  copyrightNotice?: string;
  license?: string;
  acquireLicensePage?: string;
  creditText?: string;
  [key: string]: unknown;
}

/** Mirrors `build-plugins/spaBundleResolver.ts`'s `SpaBundleInfo` field-for-field. */
export interface ArticleSpaBundleInfo {
  readonly entryJs: string;
  readonly entryCss: string;
  readonly hasSpaBundle: boolean;
}

export interface ArticleWriteCollectorOptions {
  distDir?: string;
  pluginName?: string;
}

export interface ArticleWriteCollector {
  add(filePath: string, content: string): void;
  flush(concurrency?: number): Promise<number>;
  readonly skippedByHash: number;
}

export type ArticleWriteCollectorCtor = new (
  opts?: ArticleWriteCollectorOptions,
) => ArticleWriteCollector;

/** Mirrors `build-plugins/blogContextualLinksData.ts`'s `BlogContextualLinkRule` field-for-field. */
export interface ArticleContextualLinkRule {
  readonly keywordPattern: RegExp;
  readonly targetUrl: string;
  readonly minArticleWords?: number;
  readonly priority: number;
  readonly id: string;
}

export interface SiteShellContract {
  // build-plugins/constants.ts
  baseUrl: string;
  gtagSnippet: string;
  adsenseSnippet: string;
  /**
   * Tag Partnerize (`PARTNERIZE_TAG_SNIPPET`). Opzionale di proposito: il
   * contratto attraversa il confine sito/corpus e le due meta' si aggiornano
   * con PR distinte, quindi il repo pubblicatore puo' restare indietro di un
   * giro senza che le pagine articolo stampino `undefined` nel <head>. Chi lo
   * consuma usa `?? ''`.
   */
  partnerizeTagSnippet?: string;
  offerwallFcSnippet: string;
  faviconLinks: string;
  seoStaticCssFilename: string;
  cdnPreconnectHint: string;

  // build-plugins/htmlTemplate.ts
  asyncCssLink: (href: string) => string;
  asyncCssFallbackScript: string;
  esc: (s: string) => string;
  /** Full `<head>` CSS block (preload + noscript fallback) for a hub page. */
  asyncCssHeadBlock: (entryCss?: string) => string;
  /** The SPA root element + hydration placeholders a static page must carry. */
  rootShell: (hasSpaBundle: boolean) => string;

  // build-plugins/shared/railGutters.ts
  railGutters: (enabled: boolean) => { open: string; close: string };

  // build-plugins/shared/buildDayStamp.ts — day-granularity build stamp. Must
  // come from the host: `dateModified` has to agree with what the full build
  // emits for the same page, or every fast-published archive page differs from
  // its next full-build rewrite by one JSON-LD field.
  buildDayStampIso: () => string;

  // build-plugins/shared/stripLiteralMarkdown.ts
  stripLiteralMarkdown: (s: string) => string;

  // build-plugins/batchWrite.ts
  WriteCollector: ArticleWriteCollectorCtor;

  // build-plugins/shared/titleSuffix.ts
  buildTitleWithBrand: (
    headline: string,
    brand?: string,
    maxChars?: number,
    measureLength?: (s: string) => number,
  ) => string;
  truncateHeadline: (headline: string, max: number) => string;
  titleBrandSuffix: string;
  titleMaxChars: number;
  clampMetaDescription: (description: string, max?: number) => string;
  metaDescriptionMaxChars: number;
  /**
   * Repair a description/title that arrived ALREADY cut mid-clause from the
   * corpus generator (ends on a dangling preposition/article). No-ops on text
   * that already reads as complete. See `repairSerpSnippet` in
   * `build-plugins/shared/titleSuffix.ts`.
   */
  repairSerpSnippet: (text: string, terminal?: string) => string;

  // build-plugins/shared/safeTruncate.ts
  truncateCodeUnits: (input: string, max: number) => string;

  // build-plugins/shared/chunkFiles.ts
  stableChunkFile: (name: string) => string;
  stableChunkFiles: (names: readonly string[]) => string[];

  // build-plugins/shared/seoContentTokens.ts
  differentiateH1FromTitle: (h1: string, title: string, locale: ArticleLocale) => string;

  // build-plugins/shared/inlineJsonScript.ts
  inlineScriptJson: (value: unknown) => string;

  // build-plugins/shared/criticalCss.ts
  criticalCssLink: string;

  // services/seo/imageObjectLd.ts
  imageObjectLd: (input: ArticleImageObjectInput) => Record<string, unknown>;

  // build-plugins/spaBundleResolver.ts
  resolveSpaBundle: (distDir: string) => ArticleSpaBundleInfo;

  // services/seo/organizationLd.ts
  organizationLd: Record<string, unknown>;

  // data/authors.ts
  getAuthorBySlug: (slug: string) => ArticleAuthor | undefined;

  // services/routeSlugs.data.ts — narrowed to the two fields the engine
  // actually reads (SLUG_TABLES[locale].blog / .blogCh) instead of the full
  // ~50-field SlugTable shape.
  blogIndexSlugs: Record<ArticleLocale, string>;
  swissBlogIndexSlugs: Record<ArticleLocale, string>;

  // build-plugins/seoHubsData.ts
  hubLocales: readonly ArticleLocale[];
  articlesPageSize: number;
  /**
   * Canonical page-1 path of the FRONTALIERE article archive per locale —
   * `HUB_SLUGS[locale].articlesAll`. Supplied by the host rather than derived
   * here because upstream builds it from `SLUG_TABLES[locale].blog` (a ~590-line
   * site route table) crossed with `HUB_SLUG_BY_LOCALE[locale].tutti`; re-deriving
   * it in this package would either duplicate that table or silently drift from
   * it. The svizzera section's equivalent IS derived locally, from
   * `ARTICLE_SECTIONS.svizzera.indexSlug`, which this package already owns.
   */
  articlesAllPaths: Record<ArticleLocale, string>;

  // build-plugins/blogContextualLinksData.ts
  contextualLinkRules: Record<ArticleLocale, readonly ArticleContextualLinkRule[]>;
  contextualLinksMaxPerArticle: number;
  contextualLinksDefaultMinWords: number;
}

let shell: SiteShellContract | null = null;

/** Register the real (or test-fixture) contract. Idempotent — last call wins. */
export function configureSiteShell(contract: SiteShellContract): void {
  shell = contract;
}

/** Read the currently registered contract. Throws if never configured. */
export function getSiteShell(): SiteShellContract {
  if (!shell) {
    throw new Error(
      '[packages/articles] SiteShellContract not configured. Call configureSiteShell(...) ' +
        'before rendering — see build-plugins/articlesSiteShellBootstrap.ts for the real-value ' +
        'wiring used by every old-path shim, or configure a test fixture contract directly.',
    );
  }
  return shell;
}

/** Test-only escape hatch: clear the registered contract between test files. */
export function resetSiteShellForTests(): void {
  shell = null;
}
