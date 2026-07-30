/**
 * News-ticker slim payload plugin (issues #3528 / #3532).
 *
 * The homepage `NewsFeed` ticker shows the 5 most recent blog articles.
 * Before this plugin it did so by loading the FULL blog metadata locale
 * chunk (`blog-meta-it.js`, ~1.2 MB raw / ~305 KB tx) plus the full
 * `blog-articles-data.js` registry (~620 KB raw / ~80 KB tx) on every
 * homepage view — ~385 KB of transfer and two main-thread JS parse/eval
 * long tasks in the mobile interactive window, just to render 5 titles.
 *
 * This plugin replaces the *content* of `data/news-ticker-data.ts` (a tiny
 * committed placeholder that exports an empty list) with a build-time
 * generated payload: the 5 newest articles with per-locale titles and
 * per-locale URL slugs. Generation reuses the SAME sources the runtime
 * used, so output is identical by construction:
 *
 * - article list + dates: `ARTICLES` from `data/blog-articles-data.ts`
 *   (direct import — the module is already in vite.config's build graph);
 * - titles: `readArticleSlugs()` over `services/locales/blog-meta-*.ts`
 *   (shared reader used by seoHubsPlugin, AGENTS.md #6 single source);
 * - URL slugs: `readBlogUrlSlugs()` over `services/routerBlogData.ts`
 *   (`BLOG_SLUGS`), with the same `?? id` fallback `buildPath()` applies.
 *
 * Title fallback chain mirrors runtime `t()` exactly: locale value → IT
 * value → the literal i18n key (what `t()` renders when the key is
 * missing). Sorting mirrors the old NewsFeed code byte-for-byte
 * (stable sort by date desc over ARTICLES order).
 *
 * NOTE (config graph): relative imports only — `@/` value imports break
 * Vite's config loader (see data/blog-articles-data.ts header comment).
 */
import type { Plugin } from 'vite';
import { ARTICLES, type Article } from '../content/blog-articles-data';
import { readArticleSlugs, readBlogUrlSlugs } from './shared/articleReaders';
import { getSiteShell, type ArticleLocale as HubLocale } from './siteShell';

const TICKER_MODULE_REL = 'data/news-ticker-data.ts';
const TICKER_COUNT = 5;

export interface GeneratedTickerArticle {
  id: string;
  date: string;
  title: Record<HubLocale, string>;
  slug: Record<HubLocale, string>;
}

/**
 * Where the corpus this payload is computed from lives, relative to `rootDir`,
 * plus the locales to emit.
 *
 * Every field is optional and defaults to the SITE layout, so the in-repo
 * build callers are unchanged. The articles repository — which owns the corpus
 * and publishes `news-ticker-live.json` from it — passes its own layout
 * (`content/`) and its own locale list.
 *
 * `hubLocales` is the reason this object exists at all. It used to be read
 * from `getSiteShell()` at call time, which made this function unusable
 * outside the site: the shell is bootstrapped by the consuming repo, not by
 * this package. That is the same coupling class fixed for the post-walk worker
 * in #4971, and it is fixed the same way — the value is passed in, not
 * fetched from ambient state. When omitted, the shell is consulted exactly as
 * before, so nothing in the site build changes.
 */
export interface TickerSourceLayout {
  /** Locales to emit. Default: `getSiteShell().hubLocales` (site behaviour). */
  hubLocales?: readonly HubLocale[];
  /** Directory holding `blog-meta-{locale}.ts`. Default: `services/locales`. */
  metaDir?: string;
  /** Module exporting `BLOG_SLUGS`. Default: `services/routerBlogData.ts`. */
  slugDataFile?: string;
}

/**
 * Compute the slim ticker payload. Pure given (fs, np, rootDir) — exported
 * separately so vitest can gate generation correctness without a Vite build.
 *
 * `articlesOverride` (issue #4881 Fase 3-bis): the build-time caller
 * (generateNewsTickerModule below) omits it and gets the module-top-level
 * `ARTICLES` import, unchanged. `scripts/publish-article-chunks.mjs` passes
 * the FRESH esbuild-rebuilt registry here so the out-of-band CDN ticker
 * payload reflects an article that was fast-published after this file's own
 * `ARTICLES` import was last built — without re-running a full build.
 *
 * `layout` (issue #4974 item 2) lets the articles repository call this with
 * its own on-disk layout and locale list. Omitted everywhere in the site.
 */
export function computeTickerArticles(
  fs: typeof import('node:fs'),
  np: typeof import('node:path'),
  rootDir: string,
  articlesOverride?: readonly Article[],
  layout?: TickerSourceLayout,
): GeneratedTickerArticle[] {
  // Same selection logic the runtime NewsFeed used: stable sort by date
  // desc over ARTICLES order, top 5. Keep byte-identical semantics.
  // The shell is only consulted when the caller did not supply the locales —
  // reading it unconditionally is what made this unusable outside the site.
  const HUB_LOCALES = layout?.hubLocales ?? getSiteShell().hubLocales;
  const latest = [...(articlesOverride ?? ARTICLES)]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, TICKER_COUNT);

  const titlesByLocale = new Map<HubLocale, Map<string, string>>();
  for (const locale of HUB_LOCALES) {
    const map = new Map<string, string>();
    for (const { slug, title } of readArticleSlugs(
      fs,
      np,
      rootDir,
      locale,
      'blog-meta',
      layout?.metaDir,
    )) {
      map.set(slug, title);
    }
    titlesByLocale.set(locale, map);
  }
  const urlSlugs = readBlogUrlSlugs(fs, np, rootDir, layout?.slugDataFile);

  return latest.map((a) => {
    const title = {} as Record<HubLocale, string>;
    const slug = {} as Record<HubLocale, string>;
    const itTitle = titlesByLocale.get('it')?.get(a.id);
    for (const locale of HUB_LOCALES) {
      // Mirrors runtime t(): locale value → IT fallback → literal key.
      title[locale] =
        titlesByLocale.get(locale)?.get(a.id) ?? itTitle ?? `blog.article.${a.id}.title`;
      // Mirrors buildPath(): `_blogSlugs?.[article]?.[lang] ?? article`.
      slug[locale] = urlSlugs[a.id]?.[locale] ?? a.id;
    }
    return { id: a.id, date: a.date, title, slug };
  });
}

/** Render the generated module source served in place of the placeholder. */
export function generateNewsTickerModule(
  fs: typeof import('node:fs'),
  np: typeof import('node:path'),
  rootDir: string,
): string {
  const articles = computeTickerArticles(fs, np, rootDir);
  if (articles.length === 0) {
    // Fail loud at build time: an empty ticker payload means the article
    // registry import or the shared readers broke — never ship it silently.
    throw new Error('[news-ticker-data] generated 0 articles — ARTICLES registry empty or readers broken');
  }
  return [
    '// AUTO-GENERATED by build-plugins/newsTickerDataPlugin.ts — placeholder content replaced at build/dev time.',
    "export interface TickerArticle { id: string; date: string; title: Record<'it' | 'en' | 'de' | 'fr', string>; slug: Record<'it' | 'en' | 'de' | 'fr', string>; }",
    `export const TICKER_ARTICLES: TickerArticle[] = ${JSON.stringify(articles)};`,
    '',
  ].join('\n');
}

export function newsTickerDataPlugin(rootDir: string): Plugin {
  let targetPath: string | null = null;
  return {
    name: 'news-ticker-data',
    // No `apply` restriction: NewsFeed needs the payload in dev serve,
    // FAST_BUILD and full builds alike.
    async configResolved() {
      const np = await import('node:path');
      targetPath = np.resolve(rootDir, TICKER_MODULE_REL).replace(/\\/g, '/');
    },
    async load(id) {
      if (!targetPath) return null;
      const cleanId = id.split('?')[0].replace(/\\/g, '/');
      if (cleanId !== targetPath) return null;
      const fs = await import('node:fs');
      const np = await import('node:path');
      return generateNewsTickerModule(fs, np, rootDir);
    },
  };
}
