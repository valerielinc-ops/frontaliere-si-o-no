/**
 * Worker for postWalkCoordinatorPlugin (perf optimization 2026-04-29).
 *
 * Receives a chunk of dist/ HTML file paths and applies the same 3-step
 * transform pipeline the coordinator runs in single-threaded mode:
 *   1. flat-html-redirect (bridges)
 *   2. blog-contextual-links (blog-article index files only)
 *   3. hreflang-postprocess (strip broken hreflang)
 *
 * Why a worker: the single-threaded coordinator measured 121s wall vs 65s
 * CPU on CI (sequential profile run #25075153538). 56s of wall is pure I/O
 * wait that the second core could be hiding. With 2 workers we expect
 * ~35-40s wall by overlapping I/O across cores AND splitting CPU.
 *
 * tsx loader: this file is plain ESM JS (.mjs) so Node can boot it without
 * a TS loader at the entry point. We register tsx/esm before importing the
 * transform implementations, which live in their original `.ts` files. The
 * coordinator does NOT pass execArgv — registration happens in this entry
 * module so the worker spawn signature stays simple.
 *
 * Byte-identical output: this worker MUST produce the same dist/ HTML as
 * the single-threaded coordinator. The 3 transforms are pure functions
 * that operate per-file with the same shared inputs (existingHtmlSet,
 * blogIndexHtmlByPath). The only divergence point is write ordering, which
 * does not affect the final on-disk content because each file is written
 * by exactly one worker.
 */
import { register } from 'node:module';

// Register the TypeScript loader BEFORE importing any .ts module. This must
// happen at top-level of the worker entry — workers boot fresh Node isolates
// without inheriting the parent's loader hooks.
register('tsx/esm', import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('[postWalkWorker] must be spawned via worker_threads');
}

const { transformFlatRedirect } = await import('./flatHtmlRedirectPlugin.ts');
const { injectContextualLinks } = await import('./blogContextualLinksPlugin.ts');
const { transformHreflang } = await import('./hreflangPostprocessPlugin.ts');

const {
  distDir,
  baseUrl,
  trimmedBase,
  existingHtmlPaths,
  blogIndexEntries,
  assignedFiles,
} = workerData;

// Reconstruct the lookup structures (arrays/entries cross postMessage cheaply,
// Set/Map do not — clone shape only once, here, not per file).
const existingHtmlSet = new Set(existingHtmlPaths);
const blogIndexHtmlByPath = new Map(blogIndexEntries);

const readSibling = (siblingPath) => {
  if (!existingHtmlSet.has(siblingPath)) return null;
  try {
    return fs.readFileSync(siblingPath, 'utf-8');
  } catch {
    return null;
  }
};
const existsCheck = (absPath) => existingHtmlSet.has(absPath);

let bridgeConverted = 0;
let bridgeSkipped = 0;
let blogArticlesModified = 0;
let blogLinksInjected = 0;
let hreflangFilesRewritten = 0;
let hreflangLinksKept = 0;
let hreflangLinksDropped = 0;
let totalWrites = 0;
const writeFailures = [];

for (const filePath of assignedFiles) {
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf-8');
  } catch {
    continue;
  }
  const original = html;
  let mutated = false;
  let isBridge = false;

  if (path.basename(filePath) !== 'index.html') {
    const bridge = transformFlatRedirect({
      filePath,
      distDir,
      trimmedBase,
      readSibling,
    });
    if (bridge !== null) {
      html = bridge;
      mutated = true;
      isBridge = true;
      bridgeConverted++;
    } else {
      bridgeSkipped++;
    }
  }

  if (!isBridge) {
    const locale = blogIndexHtmlByPath.get(filePath);
    if (locale !== undefined) {
      const result = injectContextualLinks(html, locale);
      if (result.injected.length > 0 && result.html !== html) {
        html = result.html;
        mutated = true;
        blogArticlesModified++;
        blogLinksInjected += result.injected.length;
      }
    }
  }

  if (!isBridge) {
    const hreflangResult = transformHreflang(html, distDir, baseUrl, existsCheck);
    if (hreflangResult !== null) {
      html = hreflangResult.html;
      mutated = true;
      hreflangFilesRewritten++;
      hreflangLinksKept += hreflangResult.kept;
      hreflangLinksDropped += hreflangResult.dropped;
    }
  }

  if (mutated && html !== original) {
    try {
      fs.writeFileSync(filePath, html, 'utf-8');
      totalWrites++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFailures.push({ filePath, msg });
    }
  }
}

parentPort.postMessage({
  bridgeConverted,
  bridgeSkipped,
  blogArticlesModified,
  blogLinksInjected,
  hreflangFilesRewritten,
  hreflangLinksKept,
  hreflangLinksDropped,
  totalWrites,
  writeFailures,
});
