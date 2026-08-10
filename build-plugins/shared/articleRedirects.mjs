/**
 * Article rename → redirect bridges: the DATA half of a mechanism whose CODE
 * half already existed (issue #5352).
 *
 * **Read this before designing anything new here.** The site already redirects
 * renamed article URLs, and has done so in production for months:
 * `build-plugins/legacyRedirectsPlugin.ts` emits, for every `from → to` pair in
 * its map, a bridge page carrying `noindex,follow` + `<link rel="canonical">`
 * to the new URL + a 0s meta-refresh — the shape the owner chose in issue #2996
 * as this site's 301-equivalent, and the same shape `cantonOrphanRedirectsPlugin`
 * and `cfHot404BridgePlugin` use. Verified live on 2026-08-10 for article
 * renames that already went through it:
 *
 *   /articoli-frontaliere/tassa-transito-svizzera-2023/      → 200 noindex,follow
 *       canonical → /articoli-frontaliere/tassa-transito-svizzera-2026/
 *   /en/cross-border-articles/transit-fee-switzerland-2023/  → 200 noindex,follow
 *   /articoli-frontaliere/naspi-disoccupazione-frontalieri/  → 200 noindex,follow
 *
 * So the gap issue #5352 describes is NOT "no redirect mechanism for articles".
 * It is narrower, and this module closes exactly it:
 *
 *  1. the only entry point was a **hand-edited TypeScript literal inside a
 *     build plugin**, so a rename meant a code change in the build graph;
 *  2. `data/article-redirects.json` — the data file created for this purpose in
 *     commit 393411f5 (2026-05-27) — had **no reader at all**. It stayed `{}`
 *     for its whole life because nothing consumed it, so nothing rewarded
 *     filling it in;
 *  3. its only writer, `scripts/manage-article.mjs`'s `addRedirectMapping`,
 *     produced wrong keys (locale-independent slug lookup + a hardcoded
 *     `/{loc}/articoli-frontaliere/` prefix that is a real URL in exactly one
 *     of the four locales, and never for svizzera-section articles).
 *
 * The fix is deliberately NOT a second redirect mechanism — two of those are
 * worse than one. This module only parses and validates the data file;
 * `legacyRedirectsPlugin` merges the result into the same map it already had,
 * and every emitted byte comes from the existing bridge builder.
 *
 * **Why the validation is fail-closed.** A redirect map is write-once,
 * read-never: a malformed entry produces no error at runtime, it produces a
 * page that quietly does not exist (or, worse, a bridge pointing at a 404).
 * The three failures that are invisible in production and cheap here are:
 * a `to` that is not an article URL, a cross-locale pair (which breaks the
 * hreflang cluster of both articles), and a chain `a → b → c` (Googlebot
 * follows one hop of a soft redirect reliably, not two). All three throw.
 *
 * `.mjs`, not `.ts`, for the same reason as its neighbour
 * `articleSectionCore.mjs`: it must load unchanged in BOTH the Vite-bundled
 * build-plugin graph (`legacyRedirectsPlugin.ts`) and raw `node` CI scripts
 * with no TS loader (`scripts/manage-article.mjs`).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_LIST } from './articleSectionCore.mjs';

/** Repo-relative path of the redirect map. */
export const ARTICLE_REDIRECTS_FILE = 'data/article-redirects.json';

/** The four content locales, in canonical order. `it` carries no URL prefix. */
export const ARTICLE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/**
 * @typedef {Object} ArticlePathParts
 * @property {string} locale   One of {@link ARTICLE_LOCALES}.
 * @property {'frontaliere'|'svizzera'} section
 * @property {string} slug     The article slug, no slashes.
 * @property {string} path     The normalized path, always trailing-slashed.
 */

/**
 * Every article-detail URL prefix that exists, derived from
 * `ARTICLE_SECTION_CORE` so a renamed section slug cannot desync this map
 * (AGENTS.md #6). Eight entries: 2 sections × 4 locales.
 *
 * @returns {Map<string, {locale: string, section: 'frontaliere'|'svizzera'}>}
 */
export function articleSectionPrefixes() {
  /** @type {Map<string, {locale: string, section: 'frontaliere'|'svizzera'}>} */
  const out = new Map();
  for (const { section, indexSlug } of ARTICLE_SECTION_CORE_LIST) {
    for (const locale of ARTICLE_LOCALES) {
      const hub = indexSlug[locale];
      const prefix = locale === 'it' ? `/${hub}/` : `/${locale}/${hub}/`;
      out.set(prefix, { locale, section });
    }
  }
  return out;
}

/** Add the trailing slash the whole redirect pipeline assumes. */
export function withTrailingSlash(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Parse an article-DETAIL path. Returns `null` for anything else — including
 * the section hubs themselves (`/articoli-frontaliere/`), which must never be
 * a rename endpoint: a hub is not a renamed article, and bridging an article
 * to its hub is the section-level fallback `searchConsoleCompat` already owns.
 *
 * @param {unknown} p
 * @returns {ArticlePathParts | null}
 */
export function parseArticlePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  if (/[?#\s]/.test(p) || p.includes('//')) return null;
  const norm = withTrailingSlash(p);
  for (const [prefix, meta] of articleSectionPrefixes()) {
    if (!norm.startsWith(prefix)) continue;
    const slug = norm.slice(prefix.length, -1);
    if (!slug || slug.includes('/')) return null;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
    return { locale: meta.locale, section: meta.section, slug, path: norm };
  }
  return null;
}

/**
 * Validate a raw parsed `article-redirects.json` object and return it
 * normalized (trailing slashes on both sides). Throws on the first offender
 * with a message naming it — see the module header for why this is
 * fail-closed rather than skip-and-warn.
 *
 * @param {unknown} raw
 * @param {{ file?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function parseArticleRedirects(raw, opts = {}) {
  const file = opts.file ?? ARTICLE_REDIRECTS_FILE;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: deve contenere un oggetto JSON { "<vecchia URL>": "<nuova URL>" }`);
  }

  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Set<string>} */
  const targets = new Set();

  for (const [fromRaw, toRaw] of Object.entries(raw)) {
    const from = parseArticlePath(fromRaw);
    if (!from) {
      throw new Error(
        `${file}: la chiave ${JSON.stringify(fromRaw)} non e' una URL di articolo. ` +
        `Attese: ${[...articleSectionPrefixes().keys()].join(', ')}<slug>/`,
      );
    }
    if (typeof toRaw !== 'string') {
      throw new Error(`${file}: il valore di ${from.path} deve essere una stringa, non ${typeof toRaw}`);
    }
    const to = parseArticlePath(toRaw);
    if (!to) {
      throw new Error(`${file}: il valore ${JSON.stringify(toRaw)} (chiave ${from.path}) non e' una URL di articolo`);
    }
    if (from.locale !== to.locale) {
      throw new Error(
        `${file}: ${from.path} → ${to.path} attraversa i locali (${from.locale} → ${to.locale}). ` +
        'Un rename e\' within-locale: un bridge cross-locale rompe il cluster hreflang di entrambi gli articoli.',
      );
    }
    if (from.path === to.path) {
      throw new Error(`${file}: ${from.path} redirige a se stessa`);
    }
    if (Object.prototype.hasOwnProperty.call(out, from.path)) {
      throw new Error(`${file}: ${from.path} e' dichiarata due volte (le due forme con e senza slash finale coincidono)`);
    }
    out[from.path] = to.path;
    targets.add(to.path);
  }

  for (const from of Object.keys(out)) {
    if (targets.has(from)) {
      throw new Error(
        `${file}: catena di redirect su ${from} (e' insieme sorgente e destinazione). ` +
        'Ogni vecchia URL deve puntare DIRETTAMENTE alla URL finale.',
      );
    }
  }

  return out;
}

/**
 * Read + validate `data/article-redirects.json` under `rootDir`.
 *
 * A missing file yields `{}` **with a warning**, never a throw: `data/` is
 * absent from every sparse worktree in this repo (see CLAUDE.md), and a build
 * plugin must not die there. The file's PRESENCE is asserted by
 * `tests/article-rename-redirects.test.ts`, which runs on a full checkout —
 * that is what keeps "no file" from silently reading as "no redirects".
 *
 * @param {string} rootDir
 * @param {{ existsSync?: typeof existsSync, readFileSync?: typeof readFileSync, warn?: (msg: string) => void }} [io]
 * @returns {Record<string, string>}
 */
export function loadArticleRedirects(rootDir, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const readFile = io.readFileSync ?? readFileSync;
  const warn = io.warn ?? ((msg) => console.warn(msg));

  const abs = path.join(rootDir, ARTICLE_REDIRECTS_FILE);
  if (!exists(abs)) {
    warn(`\x1b[33m[article-redirects]\x1b[0m ${ARTICLE_REDIRECTS_FILE} assente — nessun bridge di rename emesso.`);
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(String(readFile(abs, 'utf-8')));
  } catch (err) {
    throw new Error(`${ARTICLE_REDIRECTS_FILE}: JSON non valido — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseArticleRedirects(parsed);
}

/**
 * Every article-detail path currently PUBLISHED, read from the two slug
 * registries under `packages/articles/content/` (via the `slugDataFile` of
 * `ARTICLE_SECTION_CORE`, which are symlinks into that corpus copy).
 *
 * Used by the tests to decide, for each redirect entry, which phase of a
 * rename it is in — see the truth table in
 * `tests/article-rename-redirects.test.ts`. Deliberately NOT used by the build
 * plugin: during the window between the corpus rename landing and the site's
 * next `pull-articles-api.mjs` sync, `from` is still live, and the plugin
 * already handles that correctly by refusing to overwrite an existing page.
 *
 * @param {string} rootDir
 * @param {{ existsSync?: typeof existsSync, readFileSync?: typeof readFileSync }} [io]
 * @returns {{ paths: Set<string>, scanned: string[], missing: string[] }}
 */
export function readPublishedArticlePaths(rootDir, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const readFile = io.readFileSync ?? readFileSync;

  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {string[]} */
  const scanned = [];
  /** @type {string[]} */
  const missing = [];

  for (const { indexSlug, slugDataFile, slugConst } of ARTICLE_SECTION_CORE_LIST) {
    const abs = path.join(rootDir, slugDataFile);
    if (!exists(abs)) {
      missing.push(slugDataFile);
      continue;
    }
    const src = String(readFile(abs, 'utf-8'));
    // Same shape/regex convention as manage-article.mjs's parseSectionSlugs and
    // scripts/ci/check-blog-slugs-sitemap-sync.mjs's parseSlugsConst.
    const block = src.match(new RegExp(`const ${slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
    const rx = /["'][^"']+["']:\s*\{\s*it:\s*["']([^"']+)["'],\s*en:\s*["']([^"']+)["'],\s*de:\s*["']([^"']+)["'],\s*fr:\s*["']([^"']+)["']/g;
    let m;
    let count = 0;
    while ((m = rx.exec(block)) !== null) {
      const bySlug = { it: m[1], en: m[2], de: m[3], fr: m[4] };
      for (const locale of ARTICLE_LOCALES) {
        const hub = indexSlug[locale];
        const prefix = locale === 'it' ? `/${hub}/` : `/${locale}/${hub}/`;
        paths.add(`${prefix}${bySlug[locale]}/`);
      }
      count++;
    }
    scanned.push(`${slugDataFile} (${count})`);
  }

  return { paths, scanned, missing };
}
