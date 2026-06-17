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
 * Locale that owns a dist output path. IT lives at the root (no prefix);
 * en/de/fr live under their `/en` `/de` `/fr` subtrees. Shared, non-locale
 * files (sitemaps, robots, /data, /og, /assets, build-id) have no locale
 * prefix and are therefore classified as `it` — they ship in the `it`/main
 * shard build, matching the current post-build split in deploy.yml.
 */
export function localeOfDistPath(filePath: string, distDir: string): EmitLocale {
  let rel = filePath.split(path.sep).join('/');
  if (distDir) {
    const dnorm = distDir.split(path.sep).join('/').replace(/\/+$/, '');
    if (rel === dnorm) rel = '';
    else if (rel.startsWith(`${dnorm}/`)) rel = rel.slice(dnorm.length + 1);
  }
  rel = rel.replace(/^\/+/, '');
  if (rel === 'en' || rel.startsWith('en/')) return 'en';
  if (rel === 'de' || rel.startsWith('de/')) return 'de';
  if (rel === 'fr' || rel.startsWith('fr/')) return 'fr';
  return 'it';
}

/** Whether a dist output path should be written by this shard build. */
export function shouldEmitPath(filePath: string, distDir: string): boolean {
  if (EMIT_ALL_LOCALES) return true;
  return EMIT_LOCALES.has(localeOfDistPath(filePath, distDir));
}
