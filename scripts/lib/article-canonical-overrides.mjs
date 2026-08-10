/**
 * Node-side reader for the per-section article canonical-override maps.
 *
 * The renderer half lives in `packages/articles/engine/shared/swissArticleCanonicalOverrides.ts`
 * (loader + resolvers) and is wired per section through
 * `packages/articles/engine/shared/canonicalOverrideFiles.mjs`. This module is
 * the SAME data read from plain `node`: `scripts/ci/check-blog-slugs-sitemap-sync.mjs`
 * and `scripts/pull-articles-api.mjs` run with no TypeScript loader and cannot
 * import the `.ts` half. It deliberately imports the candidate-path literal
 * rather than restating it — the paths are the thing most likely to drift, and
 * a drifted copy here fails silently (a map that resolves to `{}` looks exactly
 * like "no overrides configured").
 *
 * What the map means, restated once so a reader of this file does not have to
 * chase it: the shadowed member of a near-duplicate pair points its
 * `<link rel="canonical">` and `og:url` at the authoritative winner. Both pages
 * STAY LIVE at their own URL — no removal, no noindex, no redirect (repo
 * anti-cut rule) — and the only other consequence is that the shadowed URL is
 * not advertised in a sitemap, because a `<loc>` whose page canonicalises
 * elsewhere is a hard CI gate failure (`scripts/audit-sitemap-canonicals.mjs`,
 * `scripts/validate-sitemap-pages.mjs`). RSS is untouched.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CANONICAL_OVERRIDE_FILES } from '../../packages/articles/engine/shared/canonicalOverrideFiles.mjs';

export const OVERRIDE_SECTIONS = /** @type {const} */ (['frontaliere', 'svizzera']);

/**
 * Same contract as `loadSwissArticleCanonicalOverrides` in the engine: first
 * readable candidate wins, anything missing/malformed degrades to `{}`, only
 * string -> absolute-http(s)-URL entries survive.
 *
 * @param {string} root repo root
 * @param {'frontaliere' | 'svizzera'} section
 * @returns {Record<string, string>} shadowed slug -> absolute winner URL
 */
export function loadSectionCanonicalOverrides(root, section) {
  for (const candidate of CANONICAL_OVERRIDE_FILES[section] ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(resolve(root, candidate), 'utf-8'));
    } catch {
      continue;
    }
    const map = parsed?.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {};
    /** @type {Record<string, string>} */
    const cleaned = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof k === 'string' && typeof v === 'string' && v.startsWith('http')) cleaned[k] = v;
    }
    return cleaned;
  }
  return {};
}

/**
 * Every shadowed slug of every section, in one set. Keys already cover all four
 * locales, so this is the set to test a sitemap `<loc>`'s last path segment
 * against regardless of which section or locale the URL belongs to.
 *
 * @param {string} root repo root
 * @returns {Set<string>}
 */
export function loadAllShadowedSlugs(root) {
  const all = new Set();
  for (const section of OVERRIDE_SECTIONS) {
    for (const slug of Object.keys(loadSectionCanonicalOverrides(root, section))) all.add(slug);
  }
  return all;
}

/**
 * Article ids whose IT slug is a shadowed key — the ids a sitemap must NOT be
 * required to contain. Derived from the override map rather than hardcoded, so
 * a future override entry is exempted automatically.
 *
 * @param {Record<string, string>} overrides shadowed slug -> winner URL
 * @param {Record<string, Record<string, string>>} slugs articleId -> locale -> slug
 * @returns {Set<string>}
 */
export function shadowedArticleIds(overrides, slugs) {
  const ids = new Set();
  for (const [articleId, slugMap] of Object.entries(slugs)) {
    if (slugMap?.it && Object.prototype.hasOwnProperty.call(overrides, slugMap.it)) ids.add(articleId);
  }
  return ids;
}

/**
 * Removes every `<url>…</url>` block whose `<loc>` ends in a shadowed slug.
 *
 * Dropping the whole block (not just the `<loc>`) is what the svizzera
 * precedent does and is the only correct edit: the block carries the page's
 * `<xhtml:link hreflang>` alternates, and leaving them behind would advertise
 * the shadowed page's other locales while the IT one is gone. Idempotent, and a
 * no-op when nothing matches.
 *
 * The page itself is NOT touched — it keeps answering 200 at its own URL. This
 * only removes the sitemap's "please crawl this as a distinct page" signal,
 * which is the exact signal the canonical override contradicts.
 *
 * @param {string} xml
 * @param {Set<string>} shadowedSlugs
 * @returns {{ xml: string, dropped: string[] }}
 */
export function dropShadowedSitemapUrlBlocks(xml, shadowedSlugs) {
  if (shadowedSlugs.size === 0) return { xml, dropped: [] };
  const dropped = [];
  const out = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc) return block;
    const slug = loc.replace(/\/$/, '').split('/').pop();
    if (!slug || !shadowedSlugs.has(slug)) return block;
    dropped.push(loc);
    return '';
  });
  return { xml: out, dropped };
}
