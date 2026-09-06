/**
 * Shared reader for the two article slug registries.
 *
 * `routerBlogData.ts` (`BLOG_SLUGS`) and `routerSwissData.ts` (`SWISS_SLUGS`)
 * are generated object literals mapping an article id to its four locale slugs.
 * They are the site's routing truth: an id that leaves them stops being
 * reachable from the SPA and stops being emitted into `sitemap-blog.xml` /
 * `sitemap-blog-ch.xml`.
 *
 * Extracted because the parse regex was about to have a third copy.
 * `scripts/ci/check-blog-slugs-sitemap-sync.mjs` had one and
 * `scripts/lib/corpus-removal-guard.mjs` needs the same shape — and the two
 * MUST agree, because one gates the corpus sync BEFORE it writes and the other
 * gates CI AFTER. Two regexes that drift would let a removal past the pre-write
 * guard and then redden `main`, which is precisely the pair's reason to exist.
 *
 * Nothing about the sections themselves is re-typed here: the file paths, the
 * const names and the per-locale hub slugs all come from
 * `build-plugins/shared/articleSectionCore.mjs`, the single source of truth
 * that issue #4881 Fase 6 collapsed six hand-copied tuples into. A new section
 * or a renamed hub slug shipped there is picked up here for free.
 *
 * The parse is textual on purpose: these files are generated, plain node cannot
 * import TypeScript, and both callers run outside the Vite build. The block
 * extractor counts braces rather than matching a closing `};` so an indented
 * literal (the redirect table lives inside a function) is read as reliably as a
 * top-level one.
 */

import { readFileSync } from 'node:fs';

import {
  ARTICLE_SECTION_CORE,
  ARTICLE_SECTION_CORE_LIST,
} from '../../build-plugins/shared/articleSectionCore.mjs';

/** Canonical section keys, in canonical order: `frontaliere`, `svizzera`. */
export const ARTICLE_SECTION_KEYS = Object.freeze(
  ARTICLE_SECTION_CORE_LIST.map((entry) => entry.section),
);

const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/**
 * Locale-prefixed PATH bases per section, no host, trailing slash — the site
 * convention (`services/router.ts` → `buildPath`). Built from `indexSlug`
 * rather than written out, so this cannot drift from the hub slugs the router
 * and the RSS feeds use.
 */
export const ARTICLE_PATH_BASE = Object.freeze(
  Object.fromEntries(
    ARTICLE_SECTION_CORE_LIST.map((entry) => [
      entry.section,
      Object.freeze(
        Object.fromEntries(
          LOCALES.map((locale) => [
            locale,
            // Italian is the primary locale and carries no segment; every other
            // locale is prefixed. Same rule `rssFeeds.mjs` applies to the same
            // `indexSlug` table, expressed once instead of per locale.
            `${locale === 'it' ? '' : `/${locale}`}/${entry.indexSlug[locale]}/`,
          ]),
        ),
      ),
    ]),
  ),
);

/** Where each section's registry lives, and the const it exports. */
export const ARTICLE_REGISTRY_FILES = Object.freeze(
  Object.fromEntries(
    ARTICLE_SECTION_CORE_LIST.map((entry) => [
      entry.section,
      Object.freeze({ file: entry.slugDataFile, constName: entry.slugConst }),
    ]),
  ),
);

/** `counts` key in the published `manifest.json` for each section. */
export const MANIFEST_COUNT_KEY = Object.freeze({
  [ARTICLE_SECTION_CORE.frontaliere.section]: 'articles',
  [ARTICLE_SECTION_CORE.svizzera.section]: 'swissArticles',
});

/**
 * Return the source text of the object literal assigned to `constName`,
 * braces included. Empty string when the const is absent.
 */
export function extractObjectLiteral(src, constName) {
  const decl = new RegExp(`\\bconst\\s+${constName}\\b[^=]*=\\s*\\{`).exec(src);
  if (!decl) return '';
  const open = decl.index + decl[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/**
 * Every `'<id>': { … }` row inside the literal, counted as loosely as the file
 * allows: a quoted key opening a brace, nothing said about what is inside.
 *
 * This is the anti-vacuity yardstick for `parseSlugRegistry`. A flat floor
 * ("more than 100 entries") cannot tell a healthy corpus from an emit change
 * that broke the parse on 97% of the rows, because 100 is two orders of
 * magnitude under the truth and stays green either way. The row count is the
 * truth the parse must reach, and it scales with the corpus for free.
 */
export function countRegistryRows(src, constName) {
  const block = extractObjectLiteral(src, constName);
  return (block.match(/["'][^"'\n]+["']\s*:\s*\{/g) ?? []).length;
}

/**
 * Parse `{ '<id>': { it, en, de, fr } }` out of a registry source string.
 *
 * The four locale keys are read BY NAME, in whatever order and across however
 * many lines the row occupies. The earlier regex pinned the emit order on a
 * single line on the argument that a reordered emit is "worth noticing, not
 * absorbing" — but nothing was noticing: a reorder made this return `{}`, and
 * every caller (the pre-write removal guard, the CI sitemap sync) fails OPEN on
 * an empty registry. Noticing is now `countRegistryRows`'s job, which reports a
 * shortfall loudly instead of an empty corpus quietly, so the parse itself can
 * afford to be robust.
 *
 * A row still has to carry all four locales to count: a partial row is a broken
 * row, and dropping it keeps it visible in the row-count comparison.
 */
export function parseSlugRegistry(src, constName) {
  const block = extractObjectLiteral(src, constName);
  const rowRx = /["']([^"'\n]+)["']\s*:\s*\{([^{}]*)\}/g;
  /** @type {Record<string, {it: string, en: string, de: string, fr: string}>} */
  const slugs = {};
  let row;
  while ((row = rowRx.exec(block)) !== null) {
    /** @type {Record<string, string>} */
    const entry = {};
    const slugRx = /\b(it|en|de|fr)\s*:\s*["']([^"']+)["']/g;
    let m;
    while ((m = slugRx.exec(row[2])) !== null) entry[m[1]] = m[2];
    if (LOCALES.every((locale) => entry[locale])) {
      slugs[row[1]] = { it: entry.it, en: entry.en, de: entry.de, fr: entry.fr };
    }
  }
  return slugs;
}

/** Read + parse a registry file. Missing file → empty registry, never a throw. */
export function readSlugRegistry(filePath, constName) {
  let src;
  try {
    src = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  return parseSlugRegistry(src, constName);
}

/**
 * Read a registry file once and report both the parse and the row count it had
 * to reach. Callers that gate on a registry (the corpus sync) need the pair:
 * the parse alone cannot say whether it was complete.
 * Missing file → `{ registry: {}, rows: 0 }`, never a throw.
 */
export function readSlugRegistryWithRows(filePath, constName) {
  let src;
  try {
    src = readFileSync(filePath, 'utf-8');
  } catch {
    return { registry: {}, rows: 0 };
  }
  return { registry: parseSlugRegistry(src, constName), rows: countRegistryRows(src, constName) };
}

/**
 * Every locale PATH an article occupies, IT first — e.g.
 * `/articoli-svizzera/<it-slug>/` plus the three locale-prefixed variants.
 */
export function articlePathsFor(section, slugMap) {
  const bases = ARTICLE_PATH_BASE[section];
  if (!bases) return [];
  return LOCALES.filter((locale) => slugMap?.[locale]).map(
    (locale) => `${bases[locale]}${slugMap[locale]}/`,
  );
}
