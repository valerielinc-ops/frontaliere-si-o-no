#!/usr/bin/env node
/**
 * Post-build sanity check: confirms the two SPA entry files Vite is
 * configured to emit (`build-plugins/shared/spaEntryFilenames.ts`) actually
 * landed under `dist/assets/`.
 *
 * Why this runs here and not mid-build
 * -------------------------------------
 * `spaBundleResolver.ts` / `seoPageShell.ts`'s `resolveEntryAssets` used to
 * gate on `fs.existsSync(dist/assets/<file>)` inside a `closeBundle` hook —
 * but Rollup's write-to-disk phase for this build does not reliably finish
 * within *any* closeBundle hook (20+ hours of red deploys on 2026-07-26,
 * see docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames), so that
 * check raced a write that hadn't happened yet. This script runs as a
 * separate step *after* the `vite build` process has already exited —
 * Node only exits once every pending write is flushed, so there is no
 * race left to have here.
 *
 * Run via `npm run build` / `build:ci` (chained after `vite build`), not
 * imported by build-plugins code. Executed with `tsx` (not plain `node`)
 * so it can import the `.ts` constants module directly — same convention
 * as `scripts/generate-health-facilities-jobs.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from '../build-plugins/shared/spaEntryFilenames.ts';

const distDir = path.resolve(process.cwd(), 'dist');
const assetsDir = path.join(distDir, 'assets');

const missing = [SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME].filter(
  (file) => !fs.existsSync(path.join(assetsDir, file)),
);

if (missing.length > 0) {
  console.error(
    `[verify-spa-entry-assets] expected stable SPA entry file(s) missing from ${assetsDir}: ` +
    `${missing.join(', ')}. These filenames are fixed by vite.config.ts ` +
    `(entryFileNames / assetFileNames) — a mismatch means the build config ` +
    `and build-plugins/shared/spaEntryFilenames.ts constants drifted apart, ` +
    `or the entry chunk failed to emit.`,
  );
  process.exit(1);
}

console.log(`[verify-spa-entry-assets] ok — ${SPA_ENTRY_JS_FILENAME}, ${SPA_ENTRY_CSS_FILENAME} present in ${assetsDir}`);
