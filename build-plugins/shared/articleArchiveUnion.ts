/**
 * Single source of truth for an article archive's paginated page count,
 * parameterized by {@link ArticleSection}. Covers BOTH article hubs:
 *
 *  - `frontaliere` (master / cross-border): `blog-meta-it.ts` ∪ `BLOG_SLUGS`
 *    (`services/routerBlogData.ts`) → `/articoli-frontaliere/tutti/page-N/`.
 *  - `svizzera` (Switzerland-wide mirror): `blog-meta-ch-it.ts` ∪ `SWISS_SLUGS`
 *    (`services/routerSwissData.ts`) → `/articoli-svizzera/tutti/page-N/`.
 *
 * **Why this module exists.** For each section, two build plugins must agree on
 * how many paginated archive pages exist:
 *
 *  1. `seoHubsPlugin.ts` EMITS the pages, paginating the UNION of the section's
 *     meta title-keys and its slug-map keys (`emitHub`'s `articles` branch for
 *     frontaliere; `emitSvizzeraArticlesHub` for svizzera).
 *  2. `staticPagesPlugin.ts` renders the deep-link NAVIGATOR that links
 *     page-1..page-N so crawlers reach every archive page at BFS depth ≤ 2
 *     (closes the Ahrefs "orphan page" report; CLAUDE.md SEO non-negotiable #5).
 *
 * If the navigator under-counts the emitter, the trailing `/tutti/page-N/`
 * pages ship with NO incoming internal link → orphaned at BFS depth > 4, out of
 * crawl reach — exactly the regression PR #1486 fixed for the frontaliere hub
 * and #1497 fixed for svizzera. The navigator used to derive its count from the
 * META file alone (title-keys), while the emitter paginates the union; the
 * frontaliere hub ALREADY diverges today (`BLOG_SLUGS` carries entries with no
 * meta title, e.g. `iniziativa-salari-ticino`, `cantieri-traffico-a9-ticino`),
 * so its meta-only navigator can silently under-count the emitter's union and
 * orphan the final pages once the excess crosses a 100-article boundary.
 *
 * This helper computes the union slug set ONCE, exactly as each section's
 * emitter does, so both call sites cannot drift — and the two SECTIONS share
 * one parameterized code path so they can't drift from each other either
 * (AGENTS.md #6: a construct duplicated across ≥2 files → extract a shared
 * module so drift is impossible by construction).
 *
 * Both readers degrade to empty on missing/unparseable sources (preserving the
 * "emit a single empty archive page" contract: `totalPages = max(1, …)`).
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { ARTICLES_PAGE_SIZE } from '../seoHubsData';
import {
  ARTICLE_SECTIONS,
  type ArticleSection,
} from '../../services/articleSections';

/**
 * Read an article section's canonical id set: the UNION of its meta title-keys
 * (`blog.article.<slug>.title` in `{metaPrefix}-it.ts`) and its slug-map keys
 * (the `{slugConst}` block in `{slugDataFile}`). Mirrors the `masterSlugs`
 * built by the section's emitter exactly.
 */
export function readArticleArchiveUnionSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  section: ArticleSection,
): Set<string> {
  const cfg = ARTICLE_SECTIONS[section];
  const slugs = new Set<string>();

  // 1. Meta title-keys from `{metaPrefix}-it.ts` (same regex as
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
    console.warn(`[article-union] failed to read ${cfg.metaPrefix}-it.ts`, err);
  }

  // 2. Slug-map keys (`{slugConst}` block in `{slugDataFile}`; same parser as
  //    `readBlogUrlSlugs` in seoHubsPlugin.ts).
  try {
    const slugFile = np.resolve(rootDir, cfg.slugDataFile);
    if (fs.existsSync(slugFile)) {
      const src = fs.readFileSync(slugFile, 'utf-8');
      const block = src.match(new RegExp(`const ${cfg.slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
      if (block) {
        const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
        let bm: RegExpExecArray | null;
        while ((bm = rx.exec(block)) !== null) slugs.add(bm[1]);
      }
    }
  } catch (err) {
    console.warn(`[article-union] failed to read ${cfg.slugConst} from ${cfg.slugDataFile}`, err);
  }

  return slugs;
}

/**
 * Page count for an article section's archive, derived from the union slug set.
 * Always ≥ 1 (a single empty archive page is emitted when the registry is
 * empty, matching the section emitter).
 */
export function countArticleArchivePages(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  section: ArticleSection,
): number {
  const total = readArticleArchiveUnionSlugs(fs, np, rootDir, section).size;
  return Math.max(1, Math.ceil(total / ARTICLES_PAGE_SIZE));
}

// ── Section-specific convenience wrappers (call-site readability) ─────────────

/** Svizzera union slugs (`blog-meta-ch-it.ts` ∪ `SWISS_SLUGS`). */
export function readSvizzeraArticleUnionSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): Set<string> {
  return readArticleArchiveUnionSlugs(fs, np, rootDir, 'svizzera');
}

/** Svizzera archive page count. */
export function countSvizzeraArticleArchivePages(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): number {
  return countArticleArchivePages(fs, np, rootDir, 'svizzera');
}

/** Frontaliere (master) union slugs (`blog-meta-it.ts` ∪ `BLOG_SLUGS`). */
export function readFrontaliereArticleUnionSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): Set<string> {
  return readArticleArchiveUnionSlugs(fs, np, rootDir, 'frontaliere');
}

/** Frontaliere (master) archive page count. */
export function countFrontaliereArticleArchivePages(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): number {
  return countArticleArchivePages(fs, np, rootDir, 'frontaliere');
}
