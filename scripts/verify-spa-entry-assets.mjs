#!/usr/bin/env node
/**
 * Post-build sanity check: confirms the two SPA entry files Vite is
 * configured to emit (`build-plugins/shared/spaEntryFilenames.ts`) actually
 * landed under `dist/assets/`, then validates every emitted JS import against
 * the exports of its local target.
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
import { formatBrokenLinks, verifyLocalModuleLinks } from './verify-spa-module-links.mjs';
import {
  checkChunkInterfaceNames,
  checkHtmlAssetReferences,
  formatInterfaceProblems,
} from './lib/spa-chunk-interface-check.mjs';
import { isAbiChunkNamingEnabled } from '../build-plugins/shared/abiChunkNaming.mjs';

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

// Production CDN builds use a stable compatibility entry only as a bootstrap;
// the executable graph must exist under the same build-scoped namespace before
// the CDN staging step can publish it. Keeping this check here catches a
// plugin/config drift immediately after Vite, rather than after a large Pages
// or R2 upload has already started. Some benchmark/equivalence workflows set
// DEPLOY_BUILD_ID only to make their output deterministic but deliberately do
// not set ASSET_CDN or publish anything; those builds retain the ordinary
// single-graph output contract.
const deployBuildId = (process.env.DEPLOY_BUILD_ID || '').trim();
const assetCdn = (process.env.ASSET_CDN || '').trim();
if (deployBuildId && assetCdn) {
  if (!/^\d+$/.test(deployBuildId)) {
    console.error(`[verify-spa-entry-assets] DEPLOY_BUILD_ID must contain digits only, got ${JSON.stringify(deployBuildId)}`);
    process.exit(1);
  }
  const releaseEntry = path.join(assetsDir, 'releases', deployBuildId, SPA_ENTRY_JS_FILENAME);
  const stableEntry = path.join(assetsDir, SPA_ENTRY_JS_FILENAME);
  const stableSource = fs.readFileSync(stableEntry, 'utf8');
  if (!fs.existsSync(releaseEntry) || !stableSource.includes('FRONTALIERE_VERSIONED_CDN_BOOTSTRAP')) {
    console.error(
      `[verify-spa-entry-assets] build ${deployBuildId} is missing its versioned CDN graph: ` +
      `expected ${releaseEntry} and a FRONTALIERE_VERSIONED_CDN_BOOTSTRAP stable entry`,
    );
    process.exit(1);
  }
}

let moduleGraph;
try {
  moduleGraph = verifyLocalModuleLinks(assetsDir);
} catch (error) {
  console.error(`[verify-spa-module-links] unable to inspect ${assetsDir}: ${error.message}`);
  process.exit(1);
}

if (moduleGraph.broken.length > 0) {
  console.error(
    `[verify-spa-module-links] ${moduleGraph.broken.length} broken module link(s) in ${assetsDir}:\n` +
      formatBrokenLinks(moduleGraph.broken).join('\n'),
  );
  process.exit(1);
}

console.log(`[verify-spa-module-links] ok — ${moduleGraph.files.length} JavaScript asset(s) linked`);

// Interface-addressed chunk names (build-plugins/shared/abiChunkNaming.mjs):
// the filename of every chunk must agree with the export names it actually
// ships, and the fixed-name entry must export nothing. Skipped only when the
// build itself opted out with SPA_ABI_CHUNK_NAMES=0 (the documented kill switch).
if (isAbiChunkNamingEnabled()) {
  const interfaceProblems = checkChunkInterfaceNames(moduleGraph.modules, { entryFile: SPA_ENTRY_JS_FILENAME });
  if (interfaceProblems.length > 0) {
    console.error(
      `[verify-spa-chunk-interface] ${interfaceProblems.length} chunk(s) whose filename does not match their interface in ${assetsDir}:\n` +
        formatInterfaceProblems(interfaceProblems).slice(0, 60).join('\n'),
    );
    process.exit(1);
  }
  console.log('[verify-spa-chunk-interface] ok — every chunk filename matches its export names');
}

// The prerendered pages must point at files that exist. A chunk renamed by its
// interface hash that a preload emitter did not follow would ship as a 404
// hint, and index.html's resource-error handler answers a 404 with a reload.
const HTML_SAMPLE_LIMIT = 400;
function sampleHtmlPages(dir, limit) {
  const found = new Map();
  const queue = [{ dir, depth: 0 }];
  while (queue.length > 0 && found.size < limit) {
    const { dir: current, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const index = entries.find((entry) => entry.isFile() && entry.name === 'index.html');
    if (index) {
      const file = path.join(current, index.name);
      found.set(path.relative(dir, file), fs.readFileSync(file, 'utf8'));
    }
    if (depth >= 3) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'assets') queue.push({ dir: path.join(current, entry.name), depth: depth + 1 });
    }
  }
  return found;
}
const servedAssetFiles = new Set(
  moduleGraph.served
    ? [...moduleGraph.served].filter(([, present]) => present).map(([url]) => new URL(url).pathname.replace(/^\/assets\//, ''))
    : [],
);
const htmlPages = sampleHtmlPages(distDir, HTML_SAMPLE_LIMIT);
const missingAssetRefs = checkHtmlAssetReferences(htmlPages, servedAssetFiles);
if (missingAssetRefs.length > 0) {
  console.error(
    `[verify-spa-html-assets] ${missingAssetRefs.length} /assets reference(s) in ${htmlPages.size} sampled page(s) point at a chunk file name that was not emitted:\n` +
      missingAssetRefs.slice(0, 40).map(({ page, asset, reason }) => `- ${page} → ${asset} (${reason})`).join('\n'),
  );
  process.exit(1);
}
console.log(`[verify-spa-html-assets] ok — ${htmlPages.size} sampled page(s) reference only emitted assets`);
console.log(`[verify-spa-entry-assets] ok — ${SPA_ENTRY_JS_FILENAME}, ${SPA_ENTRY_CSS_FILENAME} present in ${assetsDir}`);
