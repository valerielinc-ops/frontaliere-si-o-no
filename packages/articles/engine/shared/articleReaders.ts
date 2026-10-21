/**
 * Shared, funnel-critical article-registry readers used by BOTH the page
 * emitter (`seoHubsPlugin.ts`) and the archive-page-count navigator helper
 * (`shared/articleArchiveUnion.ts`).
 *
 * **Why this module exists.** The svizzera/frontaliere archive page count is a
 * single source of truth (issue #1497 / #1486): the emitter and the navigator
 * must agree on how many `/{hub}/tutti/page-N/` pages exist, or the trailing
 * pages ship orphaned (no incoming internal link → out of crawl reach). The
 * union helper in `articleArchiveUnion.ts` used to RE-INLINE the emitter's two
 * registry readers ({@link readArticleSlugs} meta title-keys +
 * {@link readBlogUrlSlugs} slug-map keys). Byte-identical copies drift the
 * moment one side's parser changes (new meta format, different escaping) — the
 * exact #1486/#1497 class the "single source of truth" PR claimed impossible
 * by construction. Hoisting BOTH readers here, imported by the emitter and the
 * union helper, makes that drift impossible by construction (AGENTS.md #6).
 *
 * The readers live in `shared/` (not in `seoHubsPlugin.ts`) to avoid a cycle:
 * `seoHubsPlugin` already imports `readSvizzeraArticleUnionSlugs` from
 * `shared/articleArchiveUnion`, so the one-way dependency
 * `seoHubsPlugin → shared` is established; importing back from `shared` into
 * `seoHubsPlugin` would create a cycle.
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import type { ArticleLocale as HubLocale } from '../siteShell';
// @ts-ignore The site symlink can make tsc resolve this shared source from
// build-plugins/shared, where this engine-local sibling is not visible at the
// link path; runtime resolution follows the package source path.
import { parseStaticArticleTranslationSource } from './articleStaticSource.mjs';
// @ts-ignore The site symlink can make tsc resolve this shared source from
// build-plugins/shared, where this engine-local sibling is not visible at the
// link path; Node/Vite resolve the realpath correctly at runtime.
import { parseArticleUrlSlugs } from './articleReaderSource.mjs';
// Explicit `.ts`: resolved from build-plugins/shared through its symlink twin.
import { parseArticleRegistryEntries } from './articleRegistryEntries.ts';

/**
 * Read article slugs from blog-meta-{lang}.ts. Each property keyed
 * `'blog.article.<slug>.title'` is one article. The `slug` returned is
 * the canonical `BlogArticleId` key (matches `BLOG_SLUGS` keys in
 * `routerBlogData.ts`) — NOT the URL slug. Use {@link readBlogUrlSlugs}
 * to get the locale-specific URL slug for hub anchor construction.
 *
 * `metaDir` is the directory holding the meta chunks, repo-relative. It
 * defaults to the site layout (`services/locales`, where the symlinks into
 * this package's `content/` live) so every existing caller is unchanged. The
 * articles repository publishes from the corpus directly and passes its own
 * (`content`) — same AST reader, no second copy of the parse logic to drift.
 */
export function readArticleSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
  metaPrefix = 'blog-meta',
  metaDir = 'services/locales',
): Array<{ slug: string; title: string }> {
  return readArticleMetadata(fs, np, rootDir, locale, metaPrefix, metaDir).articles;
}

/**
 * Read one locale's article title and excerpt fields in a single AST pass.
 * Callers that render both the title list and its descriptions should use this
 * operation rather than invoking the two projections separately.
 */
export function readArticleMetadata(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
  metaPrefix = 'blog-meta',
  metaDir = 'services/locales',
): { articles: Array<{ slug: string; title: string }>; excerpts: Map<string, string> } {
  const file = np.resolve(rootDir, metaDir, `${metaPrefix}-${locale}.ts`);
  const articles: Array<{ slug: string; title: string }> = [];
  const excerpts = new Map<string, string>();
  if (!fs.existsSync(file)) return { articles, excerpts };
  let src: string;
  try {
    src = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[seo-hubs] failed to read ${metaPrefix}-${locale}.ts`, err);
    return { articles, excerpts };
  }
  const translations = parseStaticArticleTranslationSource(src, file);
  for (const [articleId, fields] of translations) {
    const title = fields.get('title');
    if (title !== undefined) articles.push({ slug: articleId, title });
    const excerpt = fields.get('excerpt');
    if (excerpt !== undefined) excerpts.set(articleId, excerpt);
  }
  return { articles, excerpts };
}

/**
 * `id → date` out of a section's registry, for chronological ordering.
 *
 * Read from the source AST and not by importing for the reason the article engine
 * already gives elsewhere: the registry is a TS module with extensionless
 * relative specifiers, and this code runs under plain Node ESM on the
 * fast-publish path.
 *
 * An unreadable registry yields an empty map, and callers' sorts then leave
 * the order exactly as it was — degrading to the previous behaviour rather
 * than to an empty or arbitrarily shuffled listing.
 *
 * Lives here (moved from `articleHubPagesPlugin.ts`, #5001) because the
 * archive and the topic-cluster hubs must order the same articles the same
 * way. `build-plugins/seoHubsPlugin.ts` keeps its own copy on purpose — see
 * the note above its `emitSeoHubs` export block.
 */
export function readArticleDates(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  registryFile: string,
): Map<string, string> {
  const out = new Map<string, string>();
  let src: string;
  try {
    src = fs.readFileSync(np.join(rootDir, registryFile), 'utf-8');
  } catch { /* registry absent — keep insertion order */ return out; }
  // Field-order-independent (./articleRegistryEntries.ts): the old regex here
  // required `category` right after `id`, so an entry with `updatedAt` first
  // had no date and fell out of the chronological order. `date: ''`
  // (unknown) stays out of the map, as before. Parser errors remain fatal so a
  // malformed registry cannot silently degrade to a plausible but incomplete
  // archive order.
  for (const entry of parseArticleRegistryEntries(src)) {
    if (entry.date) out.set(entry.id, entry.date);
  }
  return out;
}

/**
 * Read per-article excerpts from `{metaDir}/{metaPrefix}-{locale}.ts`, keyed
 * by `BlogArticleId` exactly as {@link readArticleSlugs} keys its titles.
 *
 * Hoisted here (issue #5001) from a private copy in `seoHubsPlugin.ts`: the
 * topic-cluster hubs need the same excerpts, both to render card previews and
 * to feed the TF-IDF topic assignment, and a second literal copy of this parser
 * is the drift this module exists to prevent (AGENTS.md #6). `seoHubsPlugin`
 * now calls this one.
 */
export function readArticleExcerpts(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
  metaPrefix = 'blog-meta',
  metaDir = 'services/locales',
): Map<string, string> {
  return readArticleMetadata(fs, np, rootDir, locale, metaPrefix, metaDir).excerpts;
}

/**
 * Read the `BlogArticleId` → per-locale URL-slug map from
 * `services/routerBlogData.ts` (the `BLOG_SLUGS` constant). Mirrors the
 * parser in `ogPagesPlugin`.
 *
 * **Why this exists.** `blog-meta-{lang}.ts` keys are `BlogArticleId`s
 * (e.g. `stipendio-netto-2026`), but the canonical sitemap URL uses the
 * locale-specific slug (`stipendio-netto-frontaliere-2026` in IT). When the
 * paginated articles archive at `/articoli-frontaliere/tutti/page-N/` lists
 * articles by `BlogArticleId`, the resulting `<a href>` does NOT match the
 * sitemap URL — and the BFS reachability audit flags ~174 articles as
 * "orphans in sitemap" even though the archive renders them.
 *
 * This map is the source of truth for `BlogArticleId → URL slug`. Returns
 * `{}` if the file is missing or unparseable (callers fall back to the
 * `BlogArticleId` as URL slug, preserving prior behaviour for tests).
 */
export function readBlogUrlSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  slugDataFile = 'services/routerBlogData.ts',
  slugConst = 'BLOG_SLUGS',
): Record<string, Record<HubLocale, string>> {
  const file = np.resolve(rootDir, slugDataFile);
  const out: Record<string, Record<HubLocale, string>> = {};
  let src: string;
  try {
    if (!fs.existsSync(file)) return out;
    src = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[seo-hubs] failed to read ${slugConst} from ${slugDataFile}`, err);
    return out;
  }
  // Keep filesystem absence/read failures backward-compatible, but do not
  // swallow a parser contract or grammar error: a partial slug registry would
  // otherwise render a superficially valid page with missing localized URLs.
  Object.assign(out, parseArticleUrlSlugs(src, slugConst));
  return out;
}
