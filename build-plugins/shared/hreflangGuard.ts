/**
 * Hreflang Guard — gating helper for cross-locale alternates.
 *
 * Why this exists
 * ---------------
 * Semrush's 2026-04-26 audit flagged 1.463 broken internal links (Issue 8/E1)
 * + 6 wrong hreflang targets (Issue 25/E8). ~90% of them are
 * `<link rel="alternate" hreflang>` tags whose target HTML file does NOT
 * actually ship in `dist/` — typically because a blog article was created
 * in IT but the EN/DE/FR translations have not been generated yet.
 *
 * Google's documented preference: hreflang alternates should ONLY be
 * emitted for locales whose translation actually exists. Missing hreflang
 * is acceptable; broken hreflang is a hard error.
 *
 * This module is the single shared filter every emitter (and the post-
 * processor pass) runs alternates through before writing HTML.
 *
 * @see hreflangPostprocessPlugin — universal pass that walks dist/ and
 *      strips broken alternates without touching the per-plugin emitters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shouldEmitLocale, EMIT_ALL_LOCALES } from './localeEmitFilter.ts';

export interface LocaleAlternates {
  readonly locale: string;
  readonly url: string;
}

/**
 * Decide whether an alternate's `locale` lives on a DIFFERENT shard than the
 * current `BUILD_LOCALE` shard — i.e. whether its target file is by-design
 * absent from this shard's dist and the alternate must be kept unconditionally
 * (cross-shard hreflang graph completeness) rather than dropped as a broken
 * link.
 *
 * Returns `false` (→ subject the alternate to the real on-disk existence
 * check) when:
 *   - the build is the default all-locale build (`EMIT_ALL_LOCALES`), OR
 *   - the alternate's locale IS emitted by this shard.
 *
 * Two special cases the raw `shouldEmitLocale` check would mishandle (the
 * adversarial findings of #2462):
 *
 *   1. `x-default` is not an EmitLocale, so `shouldEmitLocale('x-default')` is
 *      always false → the raw check would keep it unconditionally on EVERY
 *      shard. But x-default's target IS the IT root, which the `it` shard
 *      owns. We map `x-default` → `it` so on the `it` shard a genuinely
 *      missing IT root still strips the broken x-default; on en/de/fr shards
 *      it stays cross-shard and is kept.
 *
 *   2. Region-tagged values (`de-CH`, `en-US`, …) are not EmitLocales either,
 *      so the raw check would bypass the existence check for a locale the
 *      shard actually owns. No current emitter produces region-tagged
 *      hreflang values (all iterate the 4 base locales / typed shared helper),
 *      but normalising the region suffix makes the guard correct-by-
 *      construction if one ever does.
 *
 * Pure: depends only on the module-load `BUILD_LOCALE` state + the input.
 * Exported so `hreflangPostprocessPlugin.filterExistingAlternatesWith` shares
 * the EXACT same shard-ownership logic — no copy-paste drift between the two
 * filter implementations (AGENTS.md sibling-class rule).
 */
export function isCrossShardAlternate(locale: string): boolean {
  if (EMIT_ALL_LOCALES) return false;
  // x-default's target is the IT root (owned by the `it` shard); region-tagged
  // values normalise to their base locale (`de-CH` → `de`). Lowercase first so
  // a stray-cased value can't slip past the EmitLocale membership test.
  const normalized = locale.toLowerCase();
  const base = normalized === 'x-default' ? 'it' : normalized.split('-')[0];
  return !shouldEmitLocale(base);
}

/**
 * Filter hreflang alternates: keep only locales whose HTML file actually
 * exists in dist/. Prevents Semrush "broken hreflang" + "broken internal
 * link" issues by emitting hreflangs only for translated pages that ship.
 *
 * Accepts either absolute URLs (with or without trailing slash) or
 * pathname-only entries. The lookup checks for both `dist/<path>/index.html`
 * and `dist/<path>.html` (flat sibling) so it survives the
 * flatHtmlRedirectPlugin rewrite pass.
 *
 * Pure function: never mutates the input array.
 */
export function filterExistingAlternates(
  alternates: readonly LocaleAlternates[],
  distDir: string,
  baseUrl: string,
): readonly LocaleAlternates[] {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return alternates.filter(({ locale, url }) => {
    // Per-locale shard build (BUILD_LOCALE): an alternate for a locale this
    // shard did not emit points to a page that lives on ANOTHER shard. Its
    // absence from THIS shard's dist is by design, not a broken link — keep
    // it so the cross-shard hreflang graph stays complete. x-default (→ it)
    // and region-tagged values are normalised, so a locale this shard DOES
    // own is still subject to the real existence check. No-op in the default
    // all-locale build (EMIT_ALL_LOCALES short-circuits inside the helper).
    if (isCrossShardAlternate(locale)) return true;
    const pathname = stripBaseAndTrailingSlash(url, trimmedBase);
    if (pathname === '' || pathname === '/') {
      // Root index — always exists if the build ran at all.
      return fs.existsSync(path.join(distDir, 'index.html'));
    }
    const candidate = path.join(distDir, pathname, 'index.html');
    const flat = path.join(distDir, `${pathname}.html`);
    return fs.existsSync(candidate) || fs.existsSync(flat);
  });
}

/**
 * Convert a (possibly absolute) URL into a leading-slash pathname with
 * any trailing slash stripped. Resilient to query strings + fragments
 * (rare in hreflang but cheap to handle).
 */
function stripBaseAndTrailingSlash(url: string, trimmedBase: string): string {
  let p = url;
  if (p.startsWith(trimmedBase)) p = p.slice(trimmedBase.length);
  // Drop query/hash if anything ever sneaks in.
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  // Strip ALL trailing slashes (handles `//` edge case).
  p = p.replace(/\/+$/, '');
  if (p === '') return '';
  return p.startsWith('/') ? p.slice(1) : p;
}
