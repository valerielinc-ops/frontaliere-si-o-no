/**
 * Post-Walk Coordinator Plugin (perf optimization 2026-04-28, parallelized 2026-04-29).
 *
 * Replaces three sequential post-phase plugins that each walked
 * `dist/**\/*.html` independently:
 *
 *   1. `blogContextualLinksPlugin` — injected 1-2 contextual links per blog
 *      article HTML. Walked only blog articles (~800 files). ~9.5s.
 *   2. `flatHtmlRedirectPlugin` — converted every `<path>.html` with a sibling
 *      `<path>/index.html` into a redirect bridge. Walked all dist/ HTML
 *      (~220k files). ~52.7s.
 *   3. `hreflangPostprocessPlugin` — stripped broken
 *      `<link rel="alternate" hreflang>` tags whose target file did not exist
 *      on disk. Walked all dist/ HTML (~220k files). ~76.3s.
 *
 * Real production timings (deploy 25039504369): 138s combined for the three
 * walks. With this coordinator, dist/ is enumerated ONCE and each HTML file
 * is opened, transformed, and written at most ONCE.
 *
 * Order matters per file:
 *   1. **flat-html-redirect FIRST**: if a file qualifies as a bridge, it is
 *      replaced wholesale by a 9-line redirect. There is no point running
 *      blog-link injection or hreflang cleanup on a bridge — bridges contain
 *      no hreflang tags and never appear under blog article slugs.
 *   2. **blog-contextual-links SECOND**: only on the directory-form HTML of
 *      each blog article (the same set the legacy plugin targeted). Skipped
 *      if the file became a bridge in step 1.
 *   3. **hreflang-postprocess LAST**: walks the (possibly modified) HTML and
 *      strips broken hreflang entries. Skipped for bridges.
 *
 * Idempotency: each transform returns `null` to indicate "no change" so the
 * coordinator only writes a file when at least one transform produced new
 * HTML. Re-running the build with no source changes is a no-op for this
 * coordinator (modulo any new files emitted by upstream plugins).
 *
 * Backward compatibility: the three legacy plugin exports
 * (`blogContextualLinksPlugin`, `flatHtmlRedirectPlugin`,
 * `hreflangPostprocessPlugin`) remain available for unit tests and any
 * downstream code that imports them. They MUST NOT be registered alongside
 * this coordinator — duplicate work would cancel the perf win.
 *
 * Worker pool (added 2026-04-29): the per-file loop is split across N worker
 * threads (default = availableParallelism()). On the 2-core ubuntu CI runner
 * the sequential profile measured 121s wall vs 65s CPU — the 56s gap is pure
 * single-thread I/O wait that a second core can absorb. Each worker reads,
 * transforms, and writes its assigned slice independently; the inputs
 * (existingHtmlSet, blogIndexHtmlByPath) are read-only and identical across
 * workers, so output is byte-equivalent to the single-threaded path.
 *
 * Set POST_WALK_WORKERS=1 to force single-threaded execution (useful when
 * profiling or when running on a constrained runner where worker spawn cost
 * outweighs parallel gains).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Plugin } from 'vite';

import {
  injectContextualLinks,
  listBlogArticleHtmlFiles,
  readBlogIndexSlugs,
  type BlogArticleHtmlFile,
} from './blogContextualLinksPlugin';
import type { BlogLinkLocale } from './blogContextualLinksData';
import { transformFlatRedirect } from './flatHtmlRedirectPlugin';
import { transformHreflang } from './hreflangPostprocessPlugin';

interface CoordinatorOptions {
  readonly baseUrl: string;
}

interface WorkerResult {
  bridgeConverted: number;
  bridgeSkipped: number;
  blogArticlesModified: number;
  blogLinksInjected: number;
  hreflangFilesRewritten: number;
  hreflangLinksKept: number;
  hreflangLinksDropped: number;
  totalWrites: number;
  writeFailures: Array<{ filePath: string; msg: string }>;
}

/**
 * Walk every `.html` file under `dir`, skipping static-asset directories.
 */
function* walkHtml(dir: string): Iterable<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* walkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield p;
    }
  }
}

/**
 * Decide how many workers to spawn. Default: max of `availableParallelism()`
 * and `cpus().length` so we use every core the runner gives us. GitHub
 * Actions runners can report `availableParallelism()=1` (cgroup quota) even
 * when 4 vCPUs are physically available — `cpus().length` reflects the
 * physical count and is the safer floor for parallelism on CI. Capped
 * against the file count so tiny dist/ trees don't spawn idle workers.
 */
function resolveWorkerCount(fileCount: number): number {
  const override = process.env.POST_WALK_WORKERS;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(1, Math.min(n, fileCount));
    }
  }
  const fromAP =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
  const fromCpus = os.cpus()?.length ?? 0;
  const detected = Math.max(fromAP, fromCpus, 1);
  // eslint-disable-next-line no-console
  console.log(
    `[post-walk-coordinator] worker count detection: availableParallelism=${fromAP} cpus=${fromCpus} → ${Math.min(detected, fileCount)}`,
  );
  return Math.max(1, Math.min(detected, fileCount));
}

/**
 * Split a file list into N round-robin chunks. Round-robin (vs slicing)
 * matters because the file list is sorted by directory, and the cost of a
 * chunk is roughly proportional to the directories it covers — slicing
 * would give one worker all blog articles (cheap) and another all jobs
 * (heavy hreflang). Round-robin smooths it out.
 */
function chunkRoundRobin<T>(items: readonly T[], n: number): T[][] {
  const chunks: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) {
    chunks[i % n].push(items[i]);
  }
  return chunks;
}

function runSingleThreaded(
  allHtmlPaths: readonly string[],
  existingHtmlSet: ReadonlySet<string>,
  blogIndexHtmlByPath: ReadonlyMap<string, BlogLinkLocale>,
  distDir: string,
  baseUrl: string,
  trimmedBase: string,
): WorkerResult {
  const result: WorkerResult = {
    bridgeConverted: 0,
    bridgeSkipped: 0,
    blogArticlesModified: 0,
    blogLinksInjected: 0,
    hreflangFilesRewritten: 0,
    hreflangLinksKept: 0,
    hreflangLinksDropped: 0,
    totalWrites: 0,
    writeFailures: [],
  };

  const readSibling = (siblingPath: string): string | null => {
    if (!existingHtmlSet.has(siblingPath)) return null;
    try {
      return fs.readFileSync(siblingPath, 'utf-8');
    } catch {
      return null;
    }
  };

  for (const filePath of allHtmlPaths) {
    let html: string;
    try {
      html = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const original = html;
    let mutated = false;
    let isBridge = false;

    if (path.basename(filePath) !== 'index.html') {
      // Fast-path: pre-emitted bridge from cluster/jobs-seo plugins (commit
      // 45399c0779). Avoids a sync 30 KB sibling read + regex pass that
      // would re-derive the same bridge content. Mirrors the worker fast
      // path in postWalkWorker.mjs (commit 7a00222681).
      if (
        html.startsWith('<!DOCTYPE html>\n<html lang="it">\n<head>\n<meta charset="utf-8">') &&
        html.includes('<meta name="robots" content="noindex,follow">') &&
        html.includes('<script>location.replace(')
      ) {
        isBridge = true;
        result.bridgeConverted++;
        continue;
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
        result.bridgeConverted++;
      } else {
        result.bridgeSkipped++;
      }
    }

    if (!isBridge) {
      const locale = blogIndexHtmlByPath.get(filePath);
      if (locale !== undefined) {
        const r = injectContextualLinks(html, locale);
        if (r.injected.length > 0 && r.html !== html) {
          html = r.html;
          mutated = true;
          result.blogArticlesModified++;
          result.blogLinksInjected += r.injected.length;
        }
      }
    }

    if (!isBridge) {
      const r = transformHreflang(html, distDir, baseUrl, (absPath) =>
        existingHtmlSet.has(absPath),
      );
      if (r !== null) {
        html = r.html;
        mutated = true;
        result.hreflangFilesRewritten++;
        result.hreflangLinksKept += r.kept;
        result.hreflangLinksDropped += r.dropped;
      }
    }

    if (mutated && html !== original) {
      try {
        fs.writeFileSync(filePath, html, 'utf-8');
        result.totalWrites++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.writeFailures.push({ filePath, msg });
      }
    }
  }

  return result;
}

async function runInWorker(
  workerUrl: URL,
  workerData: {
    distDir: string;
    baseUrl: string;
    trimmedBase: string;
    existingHtmlPaths: readonly string[];
    blogIndexEntries: ReadonlyArray<readonly [string, BlogLinkLocale]>;
    assignedFiles: readonly string[];
  },
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    // execArgv: pass --import tsx so the worker's dynamic imports of the
    // `.ts` transform implementations resolve through tsx's loader. tsx 4.x
    // removed the `--loader` / `register('tsx/esm', ...)` API in favor of
    // `--import` (Node 22+ pattern). Without this flag the worker boots and
    // crashes on the first `import('./flatHtmlRedirectPlugin.ts')` with
    // "tsx must be loaded with --import instead of --loader".
    const worker = new Worker(workerUrl, {
      workerData,
      execArgv: ['--import', 'tsx'],
    });
    worker.once('message', (msg: WorkerResult) => resolve(msg));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`postWalkWorker exited with code ${code}`));
    });
  });
}

function mergeResults(results: WorkerResult[]): WorkerResult {
  return results.reduce<WorkerResult>(
    (acc, r) => ({
      bridgeConverted: acc.bridgeConverted + r.bridgeConverted,
      bridgeSkipped: acc.bridgeSkipped + r.bridgeSkipped,
      blogArticlesModified: acc.blogArticlesModified + r.blogArticlesModified,
      blogLinksInjected: acc.blogLinksInjected + r.blogLinksInjected,
      hreflangFilesRewritten: acc.hreflangFilesRewritten + r.hreflangFilesRewritten,
      hreflangLinksKept: acc.hreflangLinksKept + r.hreflangLinksKept,
      hreflangLinksDropped: acc.hreflangLinksDropped + r.hreflangLinksDropped,
      totalWrites: acc.totalWrites + r.totalWrites,
      writeFailures: acc.writeFailures.concat(r.writeFailures),
    }),
    {
      bridgeConverted: 0,
      bridgeSkipped: 0,
      blogArticlesModified: 0,
      blogLinksInjected: 0,
      hreflangFilesRewritten: 0,
      hreflangLinksKept: 0,
      hreflangLinksDropped: 0,
      totalWrites: 0,
      writeFailures: [],
    },
  );
}

export function postWalkCoordinatorPlugin(
  rootDir: string,
  opts: CoordinatorOptions,
): Plugin {
  const { baseUrl } = opts;
  const trimmedBase = baseUrl.replace(/\/+$/, '');

  return {
    name: 'post-walk-coordinator',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
        const distDir = path.resolve(rootDir, 'dist');
        if (!fs.existsSync(distDir)) {
          // eslint-disable-next-line no-console
          console.warn('[post-walk-coordinator] dist/ missing — skipping');
          return;
        }

        const startTotal = Date.now();

        // ── Phase A: enumerate every emitted HTML file once ──────────
        const allHtmlPaths: string[] = [];
        const existingHtmlSet = new Set<string>();
        for (const file of walkHtml(distDir)) {
          allHtmlPaths.push(file);
          existingHtmlSet.add(file);
        }
        const filesScanned = allHtmlPaths.length;
        if (filesScanned === 0) {
          // eslint-disable-next-line no-console
          console.warn('[post-walk-coordinator] no HTML files in dist/ — skipping');
          return;
        }

        // ── Phase B: load blog-articles target map ONCE ──────────────
        const blogIndexSlugs = readBlogIndexSlugs(rootDir);
        const blogArticles: readonly BlogArticleHtmlFile[] = listBlogArticleHtmlFiles(
          distDir,
          blogIndexSlugs,
        );
        const blogIndexHtmlByPath = new Map<string, BlogLinkLocale>();
        for (const article of blogArticles) {
          if (article.absPath.endsWith(path.sep + 'index.html')) {
            blogIndexHtmlByPath.set(article.absPath, article.locale);
          }
        }

        // ── Phase C: dispatch work ─────────────────────────────────
        const workerCount = resolveWorkerCount(filesScanned);
        const merged: WorkerResult =
          workerCount <= 1
            ? runSingleThreaded(
                allHtmlPaths,
                existingHtmlSet,
                blogIndexHtmlByPath,
                distDir,
                baseUrl,
                trimmedBase,
              )
            : await (async () => {
                const chunks = chunkRoundRobin(allHtmlPaths, workerCount);
                const workerUrl = new URL('./postWalkWorker.mjs', import.meta.url);
                const blogIndexEntries = Array.from(blogIndexHtmlByPath.entries());
                const results = await Promise.all(
                  chunks.map((assignedFiles) =>
                    runInWorker(workerUrl, {
                      distDir,
                      baseUrl,
                      trimmedBase,
                      existingHtmlPaths: allHtmlPaths,
                      blogIndexEntries,
                      assignedFiles,
                    }),
                  ),
                );
                return mergeResults(results);
              })();

        for (const f of merged.writeFailures) {
          // eslint-disable-next-line no-console
          console.warn(`[post-walk-coordinator] failed to write ${f.filePath}: ${f.msg}`);
        }

        const dur = ((Date.now() - startTotal) / 1000).toFixed(2);
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[36m[post-walk-coordinator]\x1b[0m scanned ${filesScanned} files in ${dur}s ` +
            `(workers: ${workerCount}) — ` +
            `bridges: ${merged.bridgeConverted} converted (${merged.bridgeSkipped} non-bridge skipped), ` +
            `blog: ${merged.blogArticlesModified} modified / ${merged.blogLinksInjected} links injected, ` +
            `hreflang: ${merged.hreflangFilesRewritten} rewritten / ${merged.hreflangLinksKept} kept / ${merged.hreflangLinksDropped} dropped, ` +
            `total writes: ${merged.totalWrites}`,
        );
      },
    },
  };
}
