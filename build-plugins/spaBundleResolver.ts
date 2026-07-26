/**
 * Deterministic SPA bundle resolver shared by every SEO plugin that emits
 * static HTML which must hydrate into the React SPA.
 *
 * Structural fix (#4745 and predecessors #4638/#4738/#4746)
 * -----------------------------------------------------------
 * This used to poll `dist/index.html` and regex-extract the entry JS/CSS
 * filenames out of its content, because those filenames used to be
 * content-hashed and were only knowable after Vite finished writing the
 * HTML. Three rounds of raising/reordering that poll (3s → 30s → 120s,
 * then "prewarm as the very first closeBundle handler") all re-failed
 * within days, because the poll target — Vite's own generated
 * `dist/index.html` — kept not existing yet at poll time, for reasons that
 * outlasted every timeout/ordering fix.
 *
 * The premise no longer holds: `vite.config.ts` stabilized the entry
 * filenames (`entryFileNames` for JS, `assetFileNames` for the CSS import
 * in `index.tsx`) so they are FIXED strings known at config-authoring time,
 * not something that has to be discovered from a build artifact at all.
 * `build-plugins/shared/spaEntryFilenames.ts` is the single source of
 * truth Vite's own config reads from, so this resolver just re-exports
 * that fact instead of re-deriving it from disk.
 *
 * The only disk check left is a single, non-retrying existence check
 * against `dist/assets/<file>` (a plain Rollup chunk/asset, not the
 * specially-templated `dist/index.html`) — the exact same single-shot
 * `fs.readdirSync(assetsDir)` pattern `shared/chunkFiles.ts` already uses
 * successfully, with no polling, in the same closeBundle-time plugins that
 * used to poll this file. That precedent is why no timeout/retry is
 * needed here: plain asset files are reliably present by closeBundle,
 * only the HTML-templating pipeline for `dist/index.html` itself was ever
 * unreliable at poll time — and this resolver no longer depends on it.
 *
 * Detail: docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from './shared/spaEntryFilenames';

export interface SpaBundleInfo {
  /** Bare filename, no `/assets/` prefix. e.g. `index-entry.js`. */
  readonly entryJs: string;
  /** Bare filename, no `/assets/` prefix. e.g. `index.css`. */
  readonly entryCss: string;
  /** Always true when this function returns (we throw otherwise) — kept on
   *  the type for callers that want to defensively gate template fragments
   *  on it. */
  readonly hasSpaBundle: true;
}

/**
 * Module-level cache. Keyed by `distDir` so a build that targets multiple
 * outputs (rare; we have one) doesn't conflate hashes. The Map is reset
 * implicitly per Vite invocation because the module is re-imported.
 */
const cache = new Map<string, SpaBundleInfo>();

/**
 * Returns the SPA entry-bundle filenames. First call per `distDir` does a
 * single existence check against `dist/assets/`; subsequent calls return
 * the cached value instantly.
 *
 * Throws immediately if either asset is missing (e.g. an unrelated build
 * regression dropped the entry chunk) instead of silently degrading —
 * failing fast here is cheap because there's no poll window to wait out.
 */
export function resolveSpaBundle(distDir: string): SpaBundleInfo {
  const cached = cache.get(distDir);
  if (cached) return cached;

  const assetsDir = path.join(distDir, 'assets');
  const missing = [SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME].filter(
    (file) => !fs.existsSync(path.join(assetsDir, file)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[spa-bundle-resolver] expected stable SPA entry file(s) missing from ${assetsDir}: ` +
      `${missing.join(', ')}. These filenames are fixed by vite.config.ts ` +
      `(entryFileNames / assetFileNames) — a mismatch means the build config ` +
      `and this resolver's shared/spaEntryFilenames.ts constants drifted apart, ` +
      `or the entry chunk failed to emit.`,
    );
  }

  const info: SpaBundleInfo = {
    entryJs: SPA_ENTRY_JS_FILENAME,
    entryCss: SPA_ENTRY_CSS_FILENAME,
    hasSpaBundle: true,
  };
  cache.set(distDir, info);
  return info;
}

/** Test/diagnostic helper. Clears the cache so the next call re-checks disk. */
export function _resetSpaBundleResolverCacheForTests(): void {
  cache.clear();
}
