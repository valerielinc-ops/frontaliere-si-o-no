/**
 * Locale-qualified chunk naming for per-article blog-body modules —
 * extracted from vite.config.ts's `output.chunkFileNames` (issue #4881
 * Fase 6 review fix) so the logic is a plain, dependency-free function
 * unit-testable without running a build.
 *
 * Per-article blog-body modules share their basename across the 4 locale
 * dirs (`<blog-body-root>/{blog-body,blog-body-ch}/<locale>/<slug>.ts` —
 * BOTH families, Ticino and the Svizzera section). Without a qualifier,
 * Rollup dedups the colliding output names by appending a counter
 * (`slug2.js` = en, `slug3.js` = fr, …) whose locale mapping is pure
 * iteration order — semantically unkeyed under stable-name caching (a
 * cached `slug2.js` could mean a different locale after a reorder). Key
 * them by locale instead: `<slug>.<locale>.js` / `<slug>.ch.<locale>.js`
 * (dot separator: can't be confused with a real slug suffix nor with the
 * legacy `-<hash8>` shape the CDN janitor prunes).
 *
 * TWO path shapes must match, not just one:
 *  - legacy in-repo path: `services/locales/blog-body(-ch)?/<locale>/`
 *  - real, symlink-resolved path (issue #4881 Fase 6 colocation —
 *    `services/locales/blog-body` and `blog-body-ch` are now OS symlinks
 *    into `packages/articles/content/blog-body{,-ch}`):
 *    `packages/articles/content/blog-body(-ch)?/<locale>/`
 *
 * Vite's default `resolve.preserveSymlinks` is `false`, so Rollup resolves
 * every module to its REAL path before handing it to plugins/hooks —
 * `chunk.facadeModuleId` for a blog-body chunk is therefore the
 * `packages/articles/...` path, never the `services/locales/...` symlink
 * path it was originally imported through. A regex matching only the
 * legacy shape silently stops matching post-colocation: the build still
 * succeeds, chunk names just lose their locale key and collide by
 * iteration order — the exact "cached slug2.js could mean a different
 * locale after a reorder" hazard this naming exists to prevent. Matching
 * both shapes makes correctness independent of whichever one Rollup
 * happens to hand back, present or future.
 */

const BLOG_BODY_LOCALE_RX =
  /[\\/](?:services[\\/]locales|packages[\\/]articles[\\/]content)[\\/]blog-body(-ch)?[\\/]([a-z]{2})[\\/]/;

export interface BlogBodyChunkLocaleMatch {
  readonly isCh: boolean;
  readonly locale: string;
}

/** Extracts the {isCh, locale} key from a chunk's facadeModuleId, or null if it isn't a blog-body chunk. */
export function matchBlogBodyChunkLocale(facadeModuleId: string | null | undefined): BlogBodyChunkLocaleMatch | null {
  const m = (facadeModuleId ?? '').match(BLOG_BODY_LOCALE_RX);
  if (!m) return null;
  return { isCh: Boolean(m[1]), locale: m[2] };
}

/**
 * Builds the final `assets/<name>.js` chunk filename given the ad-filter-safe
 * base name (see `adFilterSafeChunkName` in vite.config.ts) and an optional
 * locale match. Mirrors exactly what vite.config.ts's `chunkFileNames`
 * previously inlined — same output shape, zero behavior change for already-
 * matching inputs.
 */
export function buildBlogBodyChunkFileName(safeName: string, match: BlogBodyChunkLocaleMatch | null): string {
  if (!match) return `assets/${safeName}.js`;
  return `assets/${safeName}.${match.isCh ? 'ch.' : ''}${match.locale}.js`;
}
