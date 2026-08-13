/**
 * Per-locale emit filter for sharded matrix builds.
 *
 * Opt-in via the `BUILD_LOCALE` env var (single locale or comma list, e.g.
 * `BUILD_LOCALE=en` or `BUILD_LOCALE=en,de`). When UNSET or empty ALL four
 * locales are emitted — byte-for-byte identical to the pre-filter build, so
 * the live monolithic `deploy.yml` is completely unaffected.
 *
 * Why this is safe for cross-locale SEO:
 * - The filter ONLY gates which locale's files reach disk. It NEVER touches
 *   the locale CONSTANT lists (`JOB_SEO_LOCALES`, `HREFLANG_LOCALES`, …) so
 *   the per-page hreflang block and the sitemap alternates are still built
 *   for all four locales.
 * - In jobsSeoPagesPlugin the per-job `perLocaleSlug` map is computed BEFORE
 *   the locale loop, and the `alternates` block maps over the full locale
 *   list using that map — so every emitted page keeps a complete
 *   4-locale + x-default hreflang pointing at the other shards' URLs.
 * - The cross-locale dedup Set (`emittedActiveJobPaths`) that the sitemap
 *   shard pass reads is populated for EVERY locale before any loop-skip, so
 *   the sitemap stays complete in the `it`/main shard build.
 * - The EXPIRED sitemap's hreflang alternates read `tracking[slug]` (`paths`),
 *   built upstream for every locale with NO `shouldEmitLocale` gating, so the
 *   `it`/main shard emits all locale alternates regardless of `BUILD_LOCALE`
 *   (verified #2491; anchored at the altLinks site in jobsSeoPagesPlugin).
 *
 * Scope — this filter gates the `WriteCollector` writes only, NOT every
 * write in the build:
 *   1. `WriteCollector.add()` (build-plugins/batchWrite.ts) drops any write
 *      whose dist path belongs to a non-owned locale. This covers the BULK of
 *      output (job pages, hub/landing/cluster pages — ~1M files), so it is
 *      where the I/O + artifact-size saving comes from.
 *   2. Hot emit loops (e.g. the active-job loop in jobsSeoPagesPlugin) call
 *      {@link shouldEmitLocale} to `continue` past the expensive render/minify
 *      work for non-target locales — the CPU win.
 *
 * It is NOT a universal chokepoint: ~15 plugins emit small redirect/bridge/
 * weather/alias pages via direct `fs.writeFileSync`, bypassing the collector,
 * so they still write every locale. The no-leak guarantee for a shard build
 * therefore comes from the post-build prune (scripts/ci/prune-locale-shard.mjs),
 * which removes non-owned locale output at the filesystem level — exactly the
 * way production's `push_shard` copies only `dist/<locale>`. Gating those
 * direct writers for additional CPU savings is a documented follow-up.
 */
import path from 'node:path';

export type EmitLocale = 'it' | 'en' | 'de' | 'fr';

export const ALL_EMIT_LOCALES: readonly EmitLocale[] = ['it', 'en', 'de', 'fr'] as const;

function isEmitLocale(value: string): value is EmitLocale {
  return (ALL_EMIT_LOCALES as readonly string[]).includes(value);
}

function parseEmitLocales(): Set<EmitLocale> {
  const raw = (process.env.BUILD_LOCALE ?? '').trim();
  if (!raw) return new Set(ALL_EMIT_LOCALES);
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(isEmitLocale);
  // Defensive: an unrecognised / empty value must NEVER silently emit zero
  // pages (that would ship an empty shard). Fall back to all four locales.
  if (wanted.length === 0) return new Set(ALL_EMIT_LOCALES);
  return new Set(wanted);
}

/**
 * Locales this build is responsible for emitting. Read once at module load
 * (the build process sets `BUILD_LOCALE` before Node starts).
 */
export const EMIT_LOCALES: ReadonlySet<EmitLocale> = parseEmitLocales();

/** True when the filter is inactive (all four locales emitted — the default). */
export const EMIT_ALL_LOCALES: boolean = EMIT_LOCALES.size === ALL_EMIT_LOCALES.length;

/** Whether this shard build should emit pages for the given locale. */
export function shouldEmitLocale(locale: string): boolean {
  if (EMIT_ALL_LOCALES) return true;
  return isEmitLocale(locale) && EMIT_LOCALES.has(locale);
}

/**
 * Map an hreflang locale VALUE to the base emit-locale that OWNS its target,
 * for the shard-ownership decision only (NOT for resolving the target path).
 *
 * The hreflang guards short-circuit `!shouldEmitLocale(locale) → keep` to
 * preserve cross-shard alternates whose page lives on another shard. But
 * `shouldEmitLocale` only knows the 4 base locales (`it/en/de/fr`), so two
 * value shapes slip through that short-circuit and get kept UNCONDITIONALLY —
 * skipping the real file-existence check — even on the shard that owns their
 * target page, where a missing file should be dropped as a broken hreflang:
 *   - `x-default`: always points at the IT root, owned by the `it`/main shard.
 *   - region/script-tagged values (`en-US`, `de-CH`, `fr-CH`): the page still
 *     lives in the base-locale subtree owned by that shard.
 *
 * Normalising to the owning base locale before `shouldEmitLocale` lets the
 * guard subject these to the existence check on the owning shard, while still
 * keeping them unconditionally on shards that don't own the target. A plain
 * base locale or an unknown value passes through unchanged (lowercased), so
 * `shouldEmitLocale` classifies it exactly as before.
 */
export function ownerEmitLocale(locale: string): string {
  const value = locale.trim().toLowerCase();
  if (value === 'x-default') return 'it';
  // Strip a region/script subtag: `en-us` → `en`, `de-ch` → `de`.
  return value.split('-')[0];
}

/**
 * Locale that owns a dist output path. IT lives at the root (no prefix);
 * en/de/fr live under their `/en` `/de` `/fr` subtrees. Shared, non-locale
 * files (sitemaps, robots, /data, /og, /assets, build-id) have no locale
 * prefix and are therefore classified as `it` — they ship in the `it`/main
 * shard build, matching the current post-build split in deploy.yml.
 *
 * THE ONE EXCEPTION, and why it is not a special case (issue #5327): the
 * locale HOMEPAGE is `dist/<loc>.html`, a file at the dist ROOT, not under
 * `dist/<loc>/`. It is the flat sibling of `dist/<loc>/index.html`
 * (staticPagesPlugin.ts:5434) and exists so the shard origin can answer the
 * extensionless `/<loc>` — `push-locale-shard.sh:196` stages it as
 * "homepage at /{loc}", `rehydrate-locale-shards.sh:66` treats it as half of
 * a complete shard, `audit-404-risk.mjs` maps the shard entry `de.html` to the
 * route `/de`, and `wrangler.toml` + `locale-router.js`'s
 * `/^\/(en|de|fr)(\/|$|\.html$)/` route `/‌<loc>.html` to that shard origin.
 *
 * Classifying it by prefix alone put it in `it`, which broke BOTH directions
 * of the same invariant and produced the #5327 failure:
 *   • the IT/main shard build WROTE `dist/en.html` — an EN page at a path the
 *     edge routes to the EN shard, so the trunk's copy is unreachable. With
 *     `dist/en/` pruned from that shard there was no `index.html` sibling for
 *     flatHtmlRedirectPlugin to bridge against, so it kept full INDEXABLE
 *     content instead of becoming a noindex bridge.
 *   • the EN shard build DROPPED it — the one build that should own it.
 * Net effect: nobody shipped it, and `/en.html` `/de.html` `/fr.html` answered
 * 404 in production (verified live) while the trunk kept re-emitting them.
 * Owning `<loc>.html` by `<loc>` closes both halves at once.
 */
function relOfDistPath(filePath: string, distDir: string): string {
  let rel = filePath.split(path.sep).join('/');
  if (distDir) {
    const dnorm = distDir.split(path.sep).join('/').replace(/\/+$/, '');
    if (rel === dnorm) rel = '';
    else if (rel.startsWith(`${dnorm}/`)) rel = rel.slice(dnorm.length + 1);
  }
  return rel.replace(/^\/+/, '');
}

export function localeOfDistPath(filePath: string, distDir: string): EmitLocale {
  const rel = relOfDistPath(filePath, distDir);
  // Exact match only: `dist/en.html` is EN's homepage, but `dist/enigma.html`
  // is an IT page and `dist/foo/en.html` is a nested file with no such role.
  if (rel === 'en' || rel.startsWith('en/') || rel === 'en.html') return 'en';
  if (rel === 'de' || rel.startsWith('de/') || rel === 'de.html') return 'de';
  if (rel === 'fr' || rel.startsWith('fr/') || rel === 'fr.html') return 'fr';
  return 'it';
}

/**
 * Dist-ROOT files that are not owned by one locale but shipped by EVERY shard.
 *
 * `404.html` is the only member (issue #5709). It is not a page: it is the SPA
 * boot trampoline that GitHub Pages serves for any path with no file behind it
 * (`sessionStorage.redirect` + `location.replace('/')`), and Pages honours it
 * ONLY at the repo root — which, for `frontaliere-en|de|fr`, is the shard root,
 * not `dist/<loc>/`. Owning it by prefix put it in `it`, so the en/de/fr legs
 * classified it as non-owned and `prune-locale-shard.mjs` deleted it: every
 * non-prerendered SPA route under `/en|/de|/fr` (newsletter preferences,
 * `/email-confirmed/`, …) got GitHub Pages' own generic 404 instead of the app.
 *
 * The file itself is copied by Vite from `public/` and never goes through
 * `WriteCollector`, so it reaches `dist/` on every leg regardless of this
 * function. What this exception buys is the two things that follow from it:
 * the post-build passes gated on `shouldEmitPath` (postWalkCoordinator,
 * blogImageCdnFinalize, cfHot404Bridge) still process a file that now ships —
 * without it the shards would serve an un-post-processed copy — and the
 * invariant `survivors === shouldEmitPath` that
 * `tests/build-perf-output-invariance-5130.test.ts` pins over the real prune
 * script keeps holding, which is what makes those skips provably safe.
 *
 * Exact root match only, for the same reason `<loc>.html` is exact: a nested
 * `en/404.html` has no Pages role, and matching it would keep a non-owned file.
 */
const SHARD_ROOT_SHARED_FILES: ReadonlySet<string> = new Set(['404.html']);

/** Whether a dist output path should be written by this shard build. */
export function shouldEmitPath(filePath: string, distDir: string): boolean {
  if (EMIT_ALL_LOCALES) return true;
  if (SHARD_ROOT_SHARED_FILES.has(relOfDistPath(filePath, distDir))) return true;
  return EMIT_LOCALES.has(localeOfDistPath(filePath, distDir));
}
