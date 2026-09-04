/**
 * Real-value wiring for `packages/articles`'s `SiteShellContract` (issue
 * #4881 Fase 6 — colocation).
 *
 * The package knows nothing about this site's chunk names, CSS, header/
 * footer chrome, locale strings, or base URL — it only knows the shape
 * declared in `packages/articles/engine/siteShell.ts`. This file is the ONE
 * place that imports both `configureSiteShell` and the real site-side
 * values, and hands them over. It is deliberately main-repo-only: it lives
 * in `build-plugins/`, NOT inside `packages/articles/`, so importing it FROM
 * the package would itself be a confinement violation.
 *
 * Side-effect import only (no named exports are meant to be consumed).
 * Every old-path shim left behind by the colocation move
 * (`build-plugins/ogPagesPlugin.ts`, `blogContextualLinksPlugin.ts`,
 * `articleSeoFallback.ts`, `newsTickerDataPlugin.ts`,
 * `shared/articleArchiveUnion.ts`) imports this file first, so every
 * existing consumer keeps rendering byte-identical output without knowing
 * the engine physically moved. Any NEW consumer that imports
 * `packages/articles/index.ts` directly (bypassing the old-path shims) MUST
 * import this file first too, or `getSiteShell()` throws.
 */
import {
  BASE_URL,
  GTAG_SNIPPET,
  PARTNERIZE_TAG_SNIPPET,
  ADSENSE_SNIPPET,
  OFFERWALL_FC_SNIPPET,
  FAVICON_LINKS,
  SEO_STATIC_CSS_FILENAME,
  CDN_PRECONNECT_HINT,
} from './constants';
import { asyncCssLink, ASYNC_CSS_FALLBACK_SCRIPT, esc, asyncCssHeadBlock, rootShell } from './htmlTemplate';
import { WriteCollector } from './batchWrite';
import {
  buildTitleWithBrand,
  truncateHeadline,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
  clampMetaDescription,
  META_DESCRIPTION_MAX_CHARS,
  repairSerpSnippet,
} from './shared/titleSuffix';
import { resolveSpaBundle } from './spaBundleResolver';
import { truncateCodeUnits } from './shared/safeTruncate';
import { stableChunkFile, stableChunkFiles } from './shared/chunkFiles';
import { differentiateH1FromTitle } from './shared/seoContentTokens';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { CRITICAL_CSS_LINK } from './shared/criticalCss';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { ORGANIZATION_LD } from '../services/seo/organizationLd';
import { getAuthorBySlug } from '../data/authors';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import { HUB_LOCALES, ARTICLES_PAGE_SIZE, HUB_SLUGS } from './seoHubsData';
import { railGutters } from './shared/railGutters';
import { buildDayStampIso } from './shared/buildDayStamp';
import { stripLiteralMarkdown } from './shared/stripLiteralMarkdown';
import {
  BLOG_CONTEXTUAL_LINKS,
  BLOG_LINKS_MAX_PER_ARTICLE,
  BLOG_LINKS_MIN_ARTICLE_WORDS,
} from './blogContextualLinksData';
import {
  configureSiteShell,
  type SiteShellContract,
  type ArticleLocale,
} from '../packages/articles/engine/siteShell';

const blogIndexSlugs: Record<ArticleLocale, string> = {
  it: SLUG_TABLES.it.blog,
  en: SLUG_TABLES.en.blog,
  de: SLUG_TABLES.de.blog,
  fr: SLUG_TABLES.fr.blog,
};

const swissBlogIndexSlugs: Record<ArticleLocale, string> = {
  it: SLUG_TABLES.it.blogCh,
  en: SLUG_TABLES.en.blogCh,
  de: SLUG_TABLES.de.blogCh,
  fr: SLUG_TABLES.fr.blogCh,
};

const contract: SiteShellContract = {
  baseUrl: BASE_URL,
  gtagSnippet: GTAG_SNIPPET,
  adsenseSnippet: ADSENSE_SNIPPET,
  partnerizeTagSnippet: PARTNERIZE_TAG_SNIPPET,
  offerwallFcSnippet: OFFERWALL_FC_SNIPPET,
  faviconLinks: FAVICON_LINKS,
  seoStaticCssFilename: SEO_STATIC_CSS_FILENAME,
  cdnPreconnectHint: CDN_PRECONNECT_HINT,

  asyncCssLink,
  asyncCssFallbackScript: ASYNC_CSS_FALLBACK_SCRIPT,
  esc,
  asyncCssHeadBlock,
  rootShell,

  railGutters,

  buildDayStampIso,

  stripLiteralMarkdown,

  WriteCollector,

  buildTitleWithBrand,
  truncateHeadline,
  titleBrandSuffix: TITLE_BRAND_SUFFIX,
  titleMaxChars: TITLE_MAX_CHARS,
  clampMetaDescription,
  metaDescriptionMaxChars: META_DESCRIPTION_MAX_CHARS,
  repairSerpSnippet,

  truncateCodeUnits,

  stableChunkFile,
  stableChunkFiles,

  differentiateH1FromTitle,

  inlineScriptJson,

  criticalCssLink: CRITICAL_CSS_LINK,

  imageObjectLd,

  resolveSpaBundle,

  organizationLd: ORGANIZATION_LD,

  getAuthorBySlug,

  blogIndexSlugs,
  swissBlogIndexSlugs,

  hubLocales: HUB_LOCALES,
  articlesPageSize: ARTICLES_PAGE_SIZE,
  articlesAllPaths: {
    it: HUB_SLUGS.it.articlesAll,
    en: HUB_SLUGS.en.articlesAll,
    de: HUB_SLUGS.de.articlesAll,
    fr: HUB_SLUGS.fr.articlesAll,
  },

  contextualLinkRules: BLOG_CONTEXTUAL_LINKS,
  contextualLinksMaxPerArticle: BLOG_LINKS_MAX_PER_ARTICLE,
  contextualLinksDefaultMinWords: BLOG_LINKS_MIN_ARTICLE_WORDS,
};

configureSiteShell(contract);

// Exported for host/shell-contract-fingerprint parity checks (issue #4974
// item 3): the articles repo carries a transported copy of every scalar here,
// and both repos assert the same fingerprint so a drift fails on both sides.
export { contract };
