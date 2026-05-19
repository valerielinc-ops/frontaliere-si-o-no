/**
 * Worker for relatedSearchClustersPlugin parallel cluster-page emission.
 *
 * Runs in a node:worker_threads child to render a slice of cluster pages
 * (renderClusterPage + buildFlatBridgeFromSibling) and writes both the
 * canonical `index.html` and the flat-bridge `.html` to dist/ DIRECTLY.
 *
 * Bypasses WriteCollector on purpose: workers already give us 4-way
 * parallel I/O over the file system; the collector's role (buffered
 * Promise.all flush) is redundant here. Trade-off: write-collision
 * tracking lives in the registry layer only for clusters; cluster-emit
 * has no known collision pattern (each slug→locale pair owns its path).
 *
 * Byte-identicality contract: the worker calls the SAME renderClusterPage
 * function as the main-thread path (imported via tsx dynamic import).
 * Any divergence would be a bug in how the slim ChunkContext is
 * reconstructed into a ClusterContext-shaped object — see the fake
 * matchingJobs note below.
 *
 * The worker reconstructs ClusterContext from a slim chunk record:
 *  - candidate: { slug, locale }  (renderClusterPage reads .candidate.slug
 *                                  + .candidate.locale only)
 *  - matchingJobs: fake objects with .location only (renderClusterPage
 *                  reads .length and .map(j => j.location) only)
 *  - keyword, city, topCompanies as-is.
 *
 * Per-worker memo caches (renderJobBoardCommuterContext +
 * buildJobBoardCommuterFaqItems via shared/jobBoardCommuterContext.ts)
 * are isolated to this worker's V8 context — same as the main thread's
 * memo state would be. Per-cluster cardinality is bounded by the
 * upstream cap (30000) so each worker has its own safe ceiling.
 *
 * Spawned via:
 *   new Worker(workerUrl, { workerData, execArgv: ['--import', 'tsx'] })
 *
 * Returns via postMessage:
 *   { count, locs: string[], emittedFiles: string[] }
 *
 * `count` = clusters rendered. `locs` = sitemap loc URLs. `emittedFiles`
 * = dist-relative paths (for the cache-save metadata captured by the
 * caller's fast-cache path).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (!parentPort) {
  throw new Error('[relatedSearchClustersRenderWorker] must be spawned via worker_threads');
}

// Dynamic TS import works because the parent spawns with
// `execArgv: ['--import', 'tsx']`. The plugin file's module-level
// statements (constants, type definitions, function declarations,
// the commuterCtxCache Map) run once per worker. No I/O at module load.
const pluginModule = await import('./relatedSearchClustersPlugin.ts');
const flatBridgeModule = await import('./flatHtmlRedirectPlugin.ts');
const constantsModule = await import('./constants.ts');

const { renderClusterPage } = pluginModule;
const { buildFlatBridgeFromSibling } = flatBridgeModule;
const { BASE_URL } = constantsModule;

if (typeof renderClusterPage !== 'function') {
  throw new Error('[relatedSearchClustersRenderWorker] renderClusterPage not exported by relatedSearchClustersPlugin.ts');
}
if (typeof buildFlatBridgeFromSibling !== 'function') {
  throw new Error('[relatedSearchClustersRenderWorker] buildFlatBridgeFromSibling not exported by flatHtmlRedirectPlugin.ts');
}

/**
 * @typedef {{
 *   slug: string,
 *   locale: 'it' | 'en' | 'de' | 'fr',
 *   keyword: string,
 *   city: string | null,
 *   matchingJobLocations: string[],
 *   topCompanies: string[],
 *   enrichedKey: string,
 *   hreflang: Array<{ locale: string, url: string }>,
 *   related: Array<{ keyword: string, url: string }>,
 * }} ChunkContext
 */

/**
 * @type {{
 *   distDir: string,
 *   dateStamp: string,
 *   enriched: Record<string, unknown>,
 *   chunkContexts: ChunkContext[],
 * }}
 */
const {
  distDir,
  dateStamp,
  enriched,
  chunkContexts,
} = workerData;

/** @type {string[]} */
const locs = [];
/** @type {string[]} */
const emittedFiles = [];

// Reuse a shared mkdir-cache so we don't issue redundant mkdir() syscalls
// for paths whose parent already exists from a previous emit in this
// worker's chunk. Mirrors the WriteCollector's mkdir-once behaviour.
/** @type {Set<string>} */
const mkdirCache = new Set();

/**
 * @param {string} dir
 */
async function ensureDir(dir) {
  if (mkdirCache.has(dir)) return;
  await mkdir(dir, { recursive: true });
  mkdirCache.add(dir);
}

let count = 0;

for (const cctx of chunkContexts) {
  // Reconstruct ClusterContext shape — renderClusterPage reads only:
  //   ctx.candidate.locale, ctx.candidate.slug
  //   ctx.keyword, ctx.city, ctx.topCompanies
  //   ctx.matchingJobs.length, ctx.matchingJobs.map(j => j.location)
  // Anything else would be a NEW dependency and break byte-identicality.
  const ctx = {
    candidate: {
      slug: cctx.slug,
      locale: cctx.locale,
      // Padding fields ignored by renderClusterPage but kept for the
      // ClusterContext type-shape so static analyzers in workers don't
      // choke. None of these are read in the renderClusterPage critical
      // path (verified via grep at refactor time).
      jobCount: cctx.matchingJobLocations.length,
      editorialCollision: null,
    },
    keyword: cctx.keyword,
    city: cctx.city,
    matchingJobs: cctx.matchingJobLocations.map((loc) => ({ location: loc })),
    topCompanies: cctx.topCompanies,
  };

  const out = renderClusterPage({
    ctx,
    enriched: enriched[cctx.enrichedKey],
    hreflang: cctx.hreflang,
    related: cctx.related,
    distDir,
    dateStamp,
  });

  const indexPath = path.join(distDir, out.urlPath, 'index.html');
  const flatPath = path.join(distDir, out.urlPath.replace(/\/+$/, '') + '.html');
  const slashUrl = `${BASE_URL}${out.urlPath.replace(/\/+$/, '')}/`;
  const flatBridge = buildFlatBridgeFromSibling(out.html, slashUrl);

  await ensureDir(path.dirname(indexPath));
  await writeFile(indexPath, out.html, 'utf-8');
  // flatPath's dirname is the parent of indexPath's dirname — ensure it too.
  await ensureDir(path.dirname(flatPath));
  await writeFile(flatPath, flatBridge, 'utf-8');

  emittedFiles.push(path.relative(distDir, indexPath));
  emittedFiles.push(path.relative(distDir, flatPath));
  locs.push(out.loc);
  count++;
}

parentPort.postMessage({ count, locs, emittedFiles });
