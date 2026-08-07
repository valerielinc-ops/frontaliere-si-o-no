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
 * Parse `{ '<id>': { it, en, de, fr } }` out of a registry source string.
 * Same shape the generator emits — key order is fixed, so the regex pins it
 * rather than parsing generically: a reordered emit is a generator change worth
 * noticing, not absorbing.
 */
export function parseSlugRegistry(src, constName) {
  const block = extractObjectLiteral(src, constName);
  const rx =
    /["']([^"']+)["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
  /** @type {Record<string, {it: string, en: string, de: string, fr: string}>} */
  const slugs = {};
  let m;
  while ((m = rx.exec(block)) !== null) {
    slugs[m[1]] = { it: m[2], en: m[3], de: m[4], fr: m[5] };
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
