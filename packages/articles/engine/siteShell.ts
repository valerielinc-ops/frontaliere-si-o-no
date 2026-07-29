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
  offerwallFcSnippet: string;
  faviconLinks: string;
  seoStaticCssFilename: string;
  cdnPreconnectHint: string;

  // build-plugins/htmlTemplate.ts
  asyncCssLink: (href: string) => string;
  asyncCssFallbackScript: string;
  esc: (s: string) => string;

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
