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
    const src = fs.readFileSync(file, 'utf-8');
    const block = src.match(new RegExp(`const ${slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
    if (!block) return out;
    const rx = /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
    let bm: RegExpExecArray | null;
    while ((bm = rx.exec(block)) !== null) {
      out[bm[1]] = { it: bm[2], en: bm[3], de: bm[4], fr: bm[5] };
    }
  } catch (err) {
    console.warn(`[seo-hubs] failed to read ${slugConst} from ${slugDataFile}`, err);
  }
  return out;
}
