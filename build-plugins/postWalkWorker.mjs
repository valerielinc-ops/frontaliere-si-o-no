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
// Per-phase profiler — bucketed into the same SerializedBuckets shape the
// coordinator merges via ingestBuckets() before printing the unified
// [post-walk-profile] table. tsx loader (execArgv in coordinator) makes
// this .ts import resolve from the .mjs entry point.
const {
  startTimer: profileStart,
  recordEmit: profileRecord,
  dumpBuckets: profileDumpBuckets,
} = await import('./shared/postWalkCoordinatorProfiler.ts');

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
 * Reverted 8 → 4 (was bumped to 8 in PR #795 on the assumption that the
 * worker-dispatch wall would scale linearly with lane count). Run
 * 26608004451 [post-walk-profile] disproved that:
 *   - worker-dispatch wall   PR #795 → 112.5 s (vs 110.8 s baseline, unchanged)
 *   - read total_ms          PR #795 → 3179 s  (vs 1621 s baseline, +96%)
 *   - read avg_ms            PR #795 → 3.25 ms (vs 1.66 ms baseline, +96%)
 * Doubling lanes doubled CPU work without reducing wall — the readahead
 * pipeline was already saturated at IN_FLIGHT=4 on the standard runner,
 * and the extra lanes only added scheduler/contention overhead.
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
  const __tRead = profileStart();
  try {
    html = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    profileRecord('read', __tRead);
    return;
  }
  profileRecord('read', __tRead);
  const original = html;
  let mutated = false;
  let isBridge = false;

  const baseName = path.basename(filePath);
  if (baseName !== 'index.html' && !baseName.startsWith('.')) {
    const __tCheck = profileStart();
    const preEmitted = isPreEmittedFlatBridge(html);
    profileRecord('bridge-check', __tCheck);
    if (preEmitted) {
      // Pre-emitted by the originating plugin and byte-identical to what
      // transformFlatRedirect would produce. Counts as bridgeConverted for
      // the summary line; skips both sibling read + (no-op) write.
      isBridge = true;
      bridgeConverted++;
      return;
    }
    const __tBridge = profileStart();
    const bridge = transformFlatRedirect({
      filePath,
      distDir,
      trimmedBase,
      readSibling,
    });
    profileRecord('bridge-transform', __tBridge);
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
      const __tBlog = profileStart();
      const result = injectContextualLinks(html, locale);
      profileRecord('blog-inject', __tBlog);
      if (result.injected.length > 0 && result.html !== html) {
        html = result.html;
        mutated = true;
        blogArticlesModified++;
        blogLinksInjected += result.injected.length;
      }
    }
  }

  if (!isBridge) {
    const __tHl = profileStart();
    // Same 5th argument the coordinator's single-threaded path passes. Without
    // it the page-level half of the landing-plan gate (a page that is itself a
    // landing the build no longer emits) can never fire — and deploy.yml sets
    // POST_WALK_WORKERS=2, so in production EVERY file goes through this
    // worker, not runSingleThreaded. Missing it would leave the repair half
    // inert exactly where it matters.
    const hreflangResult = transformHreflang(
      html,
      distDir,
      baseUrl,
      existsCheck,
      path.relative(distDir, filePath).split(path.sep).join('/'),
    );
    profileRecord('hreflang-transform', __tHl);
    if (hreflangResult !== null) {
      html = hreflangResult.html;
      mutated = true;
      hreflangFilesRewritten++;
      hreflangLinksKept += hreflangResult.kept;
      hreflangLinksDropped += hreflangResult.dropped;
    }
  }

  if (mutated && html !== original) {
    const __tWrite = profileStart();
    try {
      await fs.promises.writeFile(filePath, html, 'utf-8');
      totalWrites++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFailures.push({ filePath, msg });
    }
    profileRecord('write', __tWrite);
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
  // Empty array when POST_WALK_PROFILE/BUILD_PROFILE are off — coordinator
  // ingestBuckets() is a no-op on empty input and an early no-op when its
  // own ENABLED gate is false, so the round-trip cost is bounded.
  profilerBuckets: profileDumpBuckets(),
});
