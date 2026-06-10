/**
 * Single source of truth for the svizzera (Switzerland-wide) article archive
 * page count.
 *
 * **Why this module exists.** Two build plugins must agree on how many
 * paginated `/articoli-svizzera/tutti/page-N/` pages exist:
 *
 *  1. `seoHubsPlugin.ts` → `emitSvizzeraArticlesHub` EMITS the pages,
 *     paginating the UNION of `blog-meta-ch-it.ts` article slugs and the
 *     `SWISS_SLUGS` keys from `services/routerSwissData.ts`.
 *  2. `staticPagesPlugin.ts` (svizzera bare-index branch) renders the deep-link
 *     NAVIGATOR that links page-1..page-N so crawlers reach every archive page
 *     at BFS depth ≤ 2 (closes the Ahrefs "orphan page" report; CLAUDE.md SEO
 *     non-negotiable #5).
 *
 * If the navigator under-counts the emitter, the trailing `/tutti/page-N/`
 * pages ship with NO incoming internal link → orphaned at BFS depth > 4, out
 * of crawl reach — exactly the regression PR #1486 fixed. The navigator used
 * to derive its count from the META file alone (`blog-meta-ch-it.ts` title
 * keys), while the emitter paginates the union; the two coincide today but can
 * silently diverge past 100 articles (different sources of truth).
 *
 * This helper computes the union slug set ONCE, exactly as the emitter does,
 * so both call sites cannot drift (AGENTS.md #6: a construct duplicated across
 * ≥2 files → extract a shared module so drift is impossible by construction).
 *
 * Both readers degrade to empty on missing/unparseable sources (preserving the
 * "emit a single empty archive page" contract: `totalPages = max(1, …)`).
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { ARTICLES_PAGE_SIZE } from '../seoHubsData';
import { ARTICLE_SECTIONS } from '../../services/articleSections';

/**
 * Read the canonical svizzera article-id set: the UNION of meta title-keys
 * (`blog.article.<slug>.title` in `blog-meta-ch-it.ts`) and `SWISS_SLUGS`
 * keys (`services/routerSwissData.ts`). Mirrors `emitSvizzeraArticlesHub`'s
 * `masterSlugs` exactly.
 */
export function readSvizzeraArticleUnionSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): Set<string> {
  const cfg = ARTICLE_SECTIONS.svizzera;
  const slugs = new Set<string>();

  // 1. Meta title-keys from `blog-meta-ch-it.ts` (same regex as
  //    `readArticleSlugs` in seoHubsPlugin.ts).
  try {
    const metaFile = np.resolve(rootDir, 'services/locales', `${cfg.metaPrefix}-it.ts`);
    if (fs.existsSync(metaFile)) {
      const src = fs.readFileSync(metaFile, 'utf-8');
      const rx = /'blog\.article\.([^']+?)\.title':\s*'(?:[^'\\]|\\.)*'/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src)) !== null) slugs.add(m[1]);
    }
  } catch (err) {
    console.warn(`[svizzera-union] failed to read ${cfg.metaPrefix}-it.ts`, err);
  }

  // 2. `SWISS_SLUGS` keys from `services/routerSwissData.ts` (same parser as
  //    `readBlogUrlSlugs` in seoHubsPlugin.ts).
  try {
    const slugFile = np.resolve(rootDir, cfg.slugDataFile);
    if (fs.existsSync(slugFile)) {
      const src = fs.readFileSync(slugFile, 'utf-8');
      const block = src.match(/const SWISS_SLUGS[\s\S]*?\n\};/m)?.[0] ?? '';
      if (block) {
        const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
        let bm: RegExpExecArray | null;
        while ((bm = rx.exec(block)) !== null) slugs.add(bm[1]);
      }
    }
  } catch (err) {
    console.warn(`[svizzera-union] failed to read SWISS_SLUGS from ${cfg.slugDataFile}`, err);
  }

  return slugs;
}

/**
 * Page count for the svizzera article archive, derived from the union slug
 * set. Always ≥ 1 (a single empty archive page is emitted when the registry is
 * empty, matching `emitSvizzeraArticlesHub`).
 */
export function countSvizzeraArticleArchivePages(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): number {
  const total = readSvizzeraArticleUnionSlugs(fs, np, rootDir).size;
  return Math.max(1, Math.ceil(total / ARTICLES_PAGE_SIZE));
}
