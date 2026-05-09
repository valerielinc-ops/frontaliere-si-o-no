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
 * a TS loader at the entry point. The coordinator spawns the worker with
 * `execArgv: ['--import', 'tsx']` so dynamic imports of the `.ts` transform
 * files resolve correctly. The older `register('tsx/esm', ...)` API was
 * removed by tsx 4.x ("tsx must be loaded with --import instead of --loader").
 *
 * Byte-identical output: this worker MUST produce the same dist/ HTML as
 * the single-threaded coordinator. The 3 transforms are pure functions
 * that operate per-file with the same shared inputs (existingHtmlSet,
 * blogIndexHtmlByPath). The only divergence point is write ordering, which
 * does not affect the final on-disk content because each file is written
 * by exactly one worker.
 */
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

// `transformFlatRedirect` requires a SYNC sibling-existence + body reader
// (it short-circuits when the sibling index.html is missing or empty). We
// keep that sync surface and back it with the in-memory `existingHtmlSet`
// + readFileSync only when the sibling actually exists. Sibling reads are
// rare relative to the per-file walk so the sync hop here is negligible.
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

/**
 * In-flight concurrency limit per worker. The coordinator spawns N=4 workers
 * on the standard 4-vCPU CI runner; with 4 in-flight async file ops per
 * worker the runner can have ~16 concurrent reads/writes, fully saturating
 * SSD-backed I/O. Sequential profile measured CPU=170s wall=87s (~2× speedup
 * across 4 workers due to per-worker sync blocking); switching to async
 * within each worker should overlap I/O wait with peer-file CPU and bring
 * wall closer to CPU/N.
 *
 * We avoid going higher to keep aggregate fd count bounded (workers × IN_FLIGHT
 * ≤ 32 here, well under the 65535 ulimit on ubuntu-latest and the 1024
 * conservative ulimit honoured elsewhere in the repo, see batchWrite.ts).
 */
const IN_FLIGHT = 4;

/**
 * Detect a flat .html that's already a redirect bridge — emitted that way
 * directly by relatedSearchClustersPlugin / jobsSeoPagesPlugin (commit
 * 45399c0779). When we recognise it, skip the sibling read + bridge
 * recompute; the file already matches what `transformFlatRedirect` would
 * produce, so blog/hreflang transforms don't apply (bridges carry
 * noindex,follow + canonical and aren't full pages).
 *
 * Cheap: a string check on the first ~200 bytes. Avoids the sync 30 KB
 * `fs.readFileSync(sibling)` × ~150 k flat files = ~30 s of redundant
 * CPU+IO across the worker pool.
 */
const FLAT_BRIDGE_MARKER = '<meta name="robots" content="noindex,follow">';
function isPreEmittedFlatBridge(html) {
  // Quick prefix discriminator: bridges always open with this exact head.
  if (!html.startsWith('<!DOCTYPE html>\n<html lang="it">\n<head>\n<meta charset="utf-8">')) {
    return false;
  }
  // Bridge marker — distinguishes bridges from full HTML that happens to
  // share the doctype/lang prefix (none currently, but cheap insurance).
  return html.includes(FLAT_BRIDGE_MARKER) && html.includes('<script>location.replace(');
}

async function processFile(filePath) {
  let html;
  try {
    html = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return;
  }
  const original = html;
  let mutated = false;
  let isBridge = false;

  if (path.basename(filePath) !== 'index.html') {
    if (isPreEmittedFlatBridge(html)) {
      // Pre-emitted by the originating plugin and byte-identical to what
      // transformFlatRedirect would produce. Counts as bridgeConverted for
      // the summary line; skips both sibling read + (no-op) write.
      isBridge = true;
      bridgeConverted++;
      return;
    }
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
      await fs.promises.writeFile(filePath, html, 'utf-8');
      totalWrites++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFailures.push({ filePath, msg });
    }
  }
}

// Drive `assignedFiles` through a fixed-size pool of in-flight async ops.
// Order of completion does not matter: each file is independent and the
// per-file counters mutate only worker-local state (no cross-file race).
let cursor = 0;
const lane = async () => {
  while (cursor < assignedFiles.length) {
    const idx = cursor++;
    await processFile(assignedFiles[idx]);
  }
};
const lanes = [];
for (let i = 0; i < IN_FLIGHT; i++) lanes.push(lane());
await Promise.all(lanes);

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
