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
 * registry-parsing regexes ({@link readArticleSlugs} meta title-keys +
 * {@link readBlogUrlSlugs} slug-map keys). Byte-identical copies drift the
 * moment one side's regex changes (new meta format, different escaping) — the
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
import { parseSlugRegistry } from '../../scripts/lib/article-slug-registry.mjs';

/**
 * Read article slugs from blog-meta-{lang}.ts. Each line keyed
 * `'blog.article.<slug>.title'` is one article. The `slug` returned is
 * the canonical `BlogArticleId` key (matches `BLOG_SLUGS` keys in
 * `routerBlogData.ts`) — NOT the URL slug. Use {@link readBlogUrlSlugs}
 * to get the locale-specific URL slug for hub anchor construction.
 *
 * `metaDir` is the directory holding the meta chunks, repo-relative. It
 * defaults to the site layout (`services/locales`, where the symlinks into
 * this package's `content/` live) so every existing caller is unchanged. The
 * articles repository publishes from the corpus directly and passes its own
 * (`content`) — same reader, no second copy of the parse regex to drift.
 */
export function readArticleSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
  metaPrefix = 'blog-meta',
  metaDir = 'services/locales',
): Array<{ slug: string; title: string }> {
  const file = np.resolve(rootDir, metaDir, `${metaPrefix}-${locale}.ts`);
  const out: Array<{ slug: string; title: string }> = [];
  try {
    if (!fs.existsSync(file)) return out;
    const src = fs.readFileSync(file, 'utf-8');
    const seen = new Set<string>();
    const rx = /'blog\.article\.([^']+?)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const title = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.push({ slug, title });
    }
  } catch (err) {
    console.warn(`[seo-hubs] failed to read ${metaPrefix}-${locale}.ts`, err);
  }
  return out;
}

/**
 * `id → date` out of a section's registry, for chronological ordering.
 *
 * Read with a regex and not an import for the reason the article engine
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
  try {
    const src = fs.readFileSync(np.join(rootDir, registryFile), 'utf-8');
    const rx = /\{\s*id:\s*'([^']+)',\s*category:\s*'[^']*',\s*date:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) out.set(m[1], m[2]);
  } catch { /* registry absent — keep insertion order */ }
  return out;
}

/**
 * Read per-article excerpts from `{metaDir}/{metaPrefix}-{locale}.ts`, keyed
 * by `BlogArticleId` exactly as {@link readArticleSlugs} keys its titles.
 *
 * Hoisted here (issue #5001) from a private copy in `seoHubsPlugin.ts`: the
 * topic-cluster hubs need the same excerpts, both to render card previews and
 * to feed the TF-IDF topic assignment, and a second literal copy of this regex
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
  const file = np.resolve(rootDir, metaDir, `${metaPrefix}-${locale}.ts`);
  const out = new Map<string, string>();
  try {
    if (!fs.existsSync(file)) return out;
    const src = fs.readFileSync(file, 'utf-8');
    const rx = /'blog\.article\.([^']+?)\.excerpt':\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) {
      const slug = m[1];
      const excerpt = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.set(slug, excerpt);
    }
  } catch (err) {
    console.warn(`[seo-hubs] failed to read excerpts from ${metaPrefix}-${locale}.ts`, err);
  }
  return out;
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
  try {
    if (!fs.existsSync(file)) return out;
    // The parse is the shared reader: this was a hand-copy of the same regex,
    // pinned on the emit order `it,en,de,fr` on ONE line, so a reordered or
    // wrapped emit returned {} and every hub silently lost its article anchors.
    Object.assign(out, parseSlugRegistry(fs.readFileSync(file, 'utf-8'), slugConst));
  } catch (err) {
    console.warn(`[seo-hubs] failed to read ${slugConst} from ${slugDataFile}`, err);
  }
  return out;
}
