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
 * (HTML existence on disk, blogIndexHtmlByPath) are identical across workers,
 * so output is byte-equivalent to the single-threaded path without cloning a
 * full HTML path Set into every worker.
 *
 * Set POST_WALK_WORKERS=1 to force single-threaded execution (useful when
 * profiling or when running on a constrained runner where worker spawn cost
 * outweighs parallel gains).
 *
 * Opt-in incremental mode: POST_WALK_INCREMENTAL=1 reconstructs the HTML
 * existence set from current write claims plus the previously recorded
 * unmanifested roots, avoiding a second full filesystem walk on identical
 * builds. It sends only manifest-changed, proven-affected, and digest-invalid
 * derived files through the transforms. With POST_WALK_INCREMENTAL_VERIFY=1,
 * unmanifested files are sample-only and the deterministic sample is checked
 * before worker dispatch; POST_WALK_INCREMENTAL_VERIFY_SAMPLE overrides the
 * sample count. A full-write mismatch, missing walk inventory, or
 * emitter-fingerprint change falls back to the full write path. The default is
 * the unchanged full path.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Plugin } from 'vite';

import {
  injectContextualLinks,
  contextualLinkDefaults,
  listBlogArticleHtmlFiles,
  readBlogIndexSlugs,
  type BlogArticleHtmlFile,
  type ContextualLinkDefaults,
} from './blogContextualLinksPlugin';
import type { BlogLinkLocale } from './blogContextualLinksData';
import { transformFlatRedirect } from './flatHtmlRedirectPlugin';
import { transformHreflang } from './hreflangPostprocessPlugin';
import { allowExternallyServedTargets } from '../scripts/lib/externally-served-paths.mjs';
import { shouldEmitPath } from './shared/localeEmitFilter';
import {
  collectHtml,
  collectHtmlFromClaimedPaths,
  listWalkableDistTopLevels,
  relativeDistPath,
  type PostWalkIndexedInventory,
} from './shared/distHtmlWalk';
import { buildSharedHtmlPathIndex } from './shared/htmlPathIndex.mjs';
import {
  startTimer as profileStart,
  recordEmit as profileRecord,
  ingestBuckets as profileIngestBuckets,
  printSummary as printPostWalkProfile,
  type SerializedBuckets,
} from './shared/postWalkCoordinatorProfiler';
import { logBuildMem } from './shared/buildMemLog';
import { releaseIncrementalManifestState } from './shared/incrementalManifest.mjs';
import { getPathHistory } from './sharedWriteRegistry';
import {
  getKeywordLandingPlanSnapshot,
  isStaleKeywordLanding,
  landingPathFromDistRelative,
  type KeywordLandingPlanSnapshot,
} from './shared/keywordLandingPlan';
import {
  filterPostWalkDerivedDigestRecords,
  latestClaimHash,
  loadPostWalkDerivedDigestSidecar,
  loadPostWalkUnmanifestedTopLevels,
  postWalkDependencyHash,
  postWalkDerivedTemplateHash,
  wasPostWalkDerivedOutputPreserved,
  writePostWalkDerivedDigestSidecar,
  writePostWalkUnmanifestedTopLevels,
  type PostWalkDerivedDigestRecord,
  type PostWalkDerivedKind,
} from './shared/postWalkDerivedDigest';
import {
  buildPostWalkIncrementalPlanFromState,
  comparePostWalkVerification,
  describePostWalkVerificationPaths,
  loadPostWalkManifestState,
  postWalkManifestCoversHtmlPath,
  POST_WALK_INCREMENTAL_DEPENDENCY_RULE,
  postWalkIncrementalEnabled,
  postWalkIncrementalVerifyEnabled,
  postWalkIncrementalVerifySampleSize,
  releasePostWalkManifestState,
  selectPostWalkVerificationPaths,
  type PostWalkManifestProgress,
  type PostWalkManifestStateLoadResult,
  type PostWalkIncrementalPlan,
  type PostWalkVerificationPathInfo,
} from './shared/postWalkIncremental';
import {
  loadPostWalkWalkInventory,
  writePostWalkWalkInventory,
  type PostWalkWalkInventory,
} from './shared/postWalkWalkInventory';

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
  // Populated only by the coordinator's single-threaded dry-run verifier.
  // Worker threads do not need to serialize this set during normal builds.
  wouldWritePaths?: string[];
  // Worker-emitted per-phase profiler buckets. Empty array when profiler is
  // disabled (POST_WALK_PROFILE=0 or BUILD_PROFILE=0). Coordinator folds
  // these into its own module-level buckets via profileIngestBuckets()
  // before printPostWalkProfile() emits the unified table.
  profilerBuckets?: SerializedBuckets;
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

const RELATED_SEARCH_HUB_FLAT = new Set(['ricerca.html', 'search.html', 'suche.html', 'recherche.html']);
const POST_WALK_MANIFEST_LOCALES = ['it', 'en', 'de', 'fr'] as const;

function resolvePostWalkManifestLocales(): readonly string[] {
  const raw = (process.env.BUILD_LOCALE ?? '').trim();
  if (!raw) return POST_WALK_MANIFEST_LOCALES;
  const selected = raw
    .split(',')
    .map((locale) => locale.trim().toLowerCase())
    .filter((locale): locale is (typeof POST_WALK_MANIFEST_LOCALES)[number] =>
      (POST_WALK_MANIFEST_LOCALES as readonly string[]).includes(locale),
    );
  return selected.length > 0 ? [...new Set(selected)] : POST_WALK_MANIFEST_LOCALES;
}

function isPreEmittedJobFlatBridgePath(distDir: string, filePath: string): boolean {
  if (!filePath.endsWith('.html')) return false;
  const relative = relativeDistPath(distDir, filePath);
  const rel = path.sep === '/' ? relative : relative.replaceAll(path.sep, '/');
  const lastSlash = rel.lastIndexOf('/');
  const fileName = lastSlash < 0 ? rel : rel.slice(lastSlash + 1);
  if (fileName === 'index.html') return false;
  // relatedSearchClustersPlugin emits these hub flat files as full HTML; the
  // coordinator must still convert them via the normal sibling transform.
  if (RELATED_SEARCH_HUB_FLAT.has(fileName)) return false;

  // Direct flat files under job-board sections are emitted as redirect bridges
  // by jobsSeoPagesPlugin._qwFlat() and relatedSearchClustersPlugin's cluster
  // loop. Keep them in existingHtmlSet, but skip the worker read/transform.
  const firstSlash = rel.indexOf('/');
  if (firstSlash < 0) return false;
  const secondSlash = rel.indexOf('/', firstSlash + 1);
  if (rel.startsWith('cerca-lavoro-') && secondSlash < 0) return true;
  if (secondSlash < 0 || rel.indexOf('/', secondSlash + 1) >= 0) return false;
  const secondSegment = rel.slice(firstSlash + 1, secondSlash);
  return (
    rel.startsWith('en/') && secondSegment.startsWith('find-jobs-')
  ) || (
    rel.startsWith('de/') && secondSegment.startsWith('jobs-im-')
  ) || (
    rel.startsWith('fr/') && secondSegment.startsWith('trouver-emploi-')
  );
}

function runSingleThreaded(
  allHtmlPaths: readonly string[],
  existingHtmlSet: ReadonlySet<string>,
  blogIndexHtmlByPath: ReadonlyMap<string, BlogLinkLocale>,
  distDir: string,
  baseUrl: string,
  trimmedBase: string,
  writeFiles = true,
  collectWouldWritePaths = false,
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
    ...(collectWouldWritePaths ? { wouldWritePaths: [] } : {}),
  };

  // Article sections are routed away from this build and have no file here on
  // purpose (ARTICOLIFRONTALIERE/ARTICOLISVIZZERA_BUILD_EMIT_SKIP). Their URLs
  // answer 200 from the articles-repo shards, so an alternate pointing there
  // is reachable, not broken — the exemption scripts/audit-hreflang.mjs
  // already applies in targetExists(). Mirrored in postWalkWorker.mjs.
  const hreflangExists = allowExternallyServedTargets(
    (absPath: string) => existingHtmlSet.has(absPath),
    distDir,
  );

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
    const __tRead = profileStart();
    try {
      html = fs.readFileSync(filePath, 'utf-8');
    } catch {
      profileRecord('read', __tRead);
      continue;
    }
    profileRecord('read', __tRead);
    const original = html;
    let mutated = false;
    let isBridge = false;

    const baseName = path.basename(filePath);
    if (baseName !== 'index.html' && !baseName.startsWith('.')) {
      // Fast-path: pre-emitted bridge from cluster/jobs-seo plugins (commit
      // 45399c0779). Avoids a sync 30 KB sibling read + regex pass that
      // would re-derive the same bridge content. Mirrors the worker fast
      // path in postWalkWorker.mjs (commit 7a00222681).
      const __tCheck = profileStart();
      const preEmitted =
        html.startsWith('<!DOCTYPE html>\n<html lang="it">\n<head>\n<meta charset="utf-8">') &&
        html.includes('<meta name="robots" content="noindex,follow">') &&
        html.includes('<script>location.replace(');
      profileRecord('bridge-check', __tCheck);
      if (preEmitted) {
        isBridge = true;
        result.bridgeConverted++;
        continue;
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
        result.bridgeConverted++;
      } else {
        result.bridgeSkipped++;
      }
    }

    if (!isBridge) {
      const locale = blogIndexHtmlByPath.get(filePath);
      if (locale !== undefined) {
        const __tBlog = profileStart();
        const r = injectContextualLinks(html, locale);
        profileRecord('blog-inject', __tBlog);
        if (r.injected.length > 0 && r.html !== html) {
          html = r.html;
          mutated = true;
          result.blogArticlesModified++;
          result.blogLinksInjected += r.injected.length;
        }
      }
    }

    if (!isBridge) {
      const __tHl = profileStart();
      const r = transformHreflang(
        html,
        distDir,
        baseUrl,
        hreflangExists,
        path.relative(distDir, filePath).split(path.sep).join('/'),
      );
      profileRecord('hreflang-transform', __tHl);
      if (r !== null) {
        html = r.html;
        mutated = true;
        result.hreflangFilesRewritten++;
        result.hreflangLinksKept += r.kept;
        result.hreflangLinksDropped += r.dropped;
      }
    }

    if (mutated && html !== original) {
      if (collectWouldWritePaths) result.wouldWritePaths?.push(filePath);
      const __tWrite = profileStart();
      if (writeFiles) {
        try {
          fs.writeFileSync(filePath, html, 'utf-8');
          result.totalWrites++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.writeFailures.push({ filePath, msg });
        }
      }
      profileRecord('write', __tWrite);
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
    blogIndexEntries: ReadonlyArray<readonly [string, BlogLinkLocale]>;
    contextualLinkDefaults: ContextualLinkDefaults;
    assignedFiles: readonly string[];
    htmlPathIndex: ReturnType<typeof buildSharedHtmlPathIndex>;
    keywordLandingPlan: KeywordLandingPlanSnapshot;
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

function emptyWorkerResult(): WorkerResult {
  return {
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
}

function formatVerificationMismatchSample(
  paths: readonly string[],
  details: ReadonlyMap<string, PostWalkVerificationPathInfo>,
): string {
  return paths
    .slice(0, 20)
    .map((filePath) => {
      const detail = details.get(filePath);
      if (!detail) return `${filePath}|kind=unknown|top-level=unknown|reason=not-classified`;
      return `${detail.relativePath}|kind=${detail.kind}|top-level=${detail.topLevel}|reason=${detail.reason}`;
    })
    .join('; ');
}

function isBridgeCandidate(
  filePath: string,
  existingHtmlSet: ReadonlySet<string>,
): boolean {
  const baseName = path.basename(filePath);
  if (baseName === 'index.html' || baseName.startsWith('.') || !baseName.endsWith('.html')) return false;
  return existingHtmlSet.has(path.join(filePath.slice(0, -'.html'.length), 'index.html'));
}

function derivedKindForPath(
  filePath: string,
  existingHtmlSet: ReadonlySet<string>,
  blogIndexHtmlByPath: ReadonlyMap<string, BlogLinkLocale>,
): PostWalkDerivedKind | null {
  if (isBridgeCandidate(filePath, existingHtmlSet)) return 'bridge';
  return blogIndexHtmlByPath.has(filePath) ? 'blog' : null;
}

function prepareDerivedPostWalkScope(input: {
  readonly rootDir: string;
  readonly distDir: string;
  readonly paths: readonly string[];
  readonly existingHtmlSet: ReadonlySet<string>;
  readonly blogIndexHtmlByPath: ReadonlyMap<string, BlogLinkLocale>;
  readonly dependencyHash: string;
  readonly previous: ReadonlyMap<string, PostWalkDerivedDigestRecord>;
}): {
  readonly processPaths: readonly string[];
  readonly skippedPaths: ReadonlySet<string>;
  readonly records: ReadonlyMap<string, PostWalkDerivedDigestRecord>;
} {
  const selected = new Set<string>();
  const skipped = new Set<string>();
  const records = new Map<string, PostWalkDerivedDigestRecord>();
  for (const filePath of input.paths) {
    const kind = derivedKindForPath(filePath, input.existingHtmlSet, input.blogIndexHtmlByPath);
    if (kind === null) continue;
    const relative = path.relative(input.distDir, filePath).split(path.sep).join('/');
    const sourceFilePath = kind === 'bridge'
      ? path.join(filePath.slice(0, -'.html'.length), 'index.html')
      : filePath;
    const inputHash = latestClaimHash(filePath);
    records.set(relative, {
      path: relative,
      kind,
      inputHash,
      sourcePath: path.relative(input.distDir, sourceFilePath).split(path.sep).join('/'),
      sourceHash: latestClaimHash(sourceFilePath),
      dependencyHash: input.dependencyHash,
      templateHash: postWalkDerivedTemplateHash(kind),
    });
    const previous = input.previous.get(relative);
    const preserved = previous !== undefined
      && previous.kind === kind
      && previous.inputHash !== null
      && previous.inputHash === inputHash
      && previous.dependencyHash === input.dependencyHash
      && wasPostWalkDerivedOutputPreserved(input.rootDir, filePath);
    if (preserved) skipped.add(filePath);
    else selected.add(filePath);
  }
  return { processPaths: [...selected], skippedPaths: skipped, records };
}

/** Fold one worker into the accumulator without retaining a results array. */
function mergeResultInto(acc: WorkerResult, result: WorkerResult): void {
  acc.bridgeConverted += result.bridgeConverted;
  acc.bridgeSkipped += result.bridgeSkipped;
  acc.blogArticlesModified += result.blogArticlesModified;
  acc.blogLinksInjected += result.blogLinksInjected;
  acc.hreflangFilesRewritten += result.hreflangFilesRewritten;
  acc.hreflangLinksKept += result.hreflangLinksKept;
  acc.hreflangLinksDropped += result.hreflangLinksDropped;
  acc.totalWrites += result.totalWrites;
  acc.writeFailures.push(...result.writeFailures);
  if (acc.wouldWritePaths && result.wouldWritePaths) {
    acc.wouldWritePaths.push(...result.wouldWritePaths);
  }
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

        let processHtmlPaths: readonly string[] = [];
        let incrementalPlan: PostWalkIncrementalPlan | null = null;
        let incrementalManifestPhaseMs = 0;
        let incrementalPlanPhaseMs = 0;
        let incrementalVerifyPhaseMs = 0;
        const incrementalEnabled = postWalkIncrementalEnabled();
        let manifests: PostWalkManifestStateLoadResult | null = null;
        let manifestHtmlEntryCount = 0;
        let changedByKind = 'none';
        let verificationSamplePaths: readonly string[] = [];
        let verificationSampleDetails: ReadonlyMap<string, PostWalkVerificationPathInfo> = new Map();
        let derivedSidecarRecords = 0;
        let derivedSidecarSkipped = 0;
        let derivedSidecarProcessed = 0;
        let derivedSidecarReady = false;
        let derivedRecordsForWrite: ReadonlyMap<string, PostWalkDerivedDigestRecord> = new Map();
        let canPersistUnmanifestedInventory = false;
        const previousWalkInventory: PostWalkWalkInventory | null = incrementalEnabled
          ? await loadPostWalkWalkInventory(rootDir)
          : null;
        const previousDerivedSidecar = incrementalEnabled
          ? loadPostWalkDerivedDigestSidecar(rootDir)
          : new Map<string, PostWalkDerivedDigestRecord>();
        const previousUnmanifestedTopLevels = incrementalEnabled
          ? loadPostWalkUnmanifestedTopLevels(rootDir)
          : null;
        derivedSidecarRecords = previousDerivedSidecar.size;

        if (incrementalEnabled) {
          // jobsSeoPagesPlugin and relatedSearchClustersPlugin have completed
          // their manifest writes before this sequential closeBundle hook. The
          // producer maps are not needed by the coordinator; release them
          // before loading the disk snapshots so their input projections do
          // not overlap the planner's current-entry map.
          releaseIncrementalManifestState(rootDir);
          const manifestStartedAt = Date.now();
          // Load and report the two manifest cardinalities before the expensive
          // dist walk. If a later phase dies, the last [mem] marker identifies
          // whether the retained state belonged to JSONL, planning, or workers.
          // eslint-disable-next-line no-console
          console.log(
            '[post-walk-coordinator][incremental] previous=loading current=loading phase=manifest-load-start',
          );
          logBuildMem(
            'postWalkCoordinator: before-manifest',
            undefined,
            { phase: 'manifest-load' },
            { forceGc: false },
          );

          const manifestProgress = (progress: PostWalkManifestProgress): void => {
            const previous = progress.previousEntries === null
              ? 'loading'
              : String(progress.previousEntries);
            // eslint-disable-next-line no-console
            console.log(
              `[post-walk-coordinator][incremental] previous=${previous} `
                + `current=${progress.currentEntries} phase=${progress.phase}`,
            );
            logBuildMem(
              `postWalkCoordinator: ${progress.phase}`,
              undefined,
              {
                previousEntries: progress.previousEntries === null ? 'loading' : progress.previousEntries,
                currentEntries: progress.currentEntries,
              },
              { forceGc: false },
            );
          };

          manifests = fs.existsSync(path.join(rootDir, 'data', 'jobs.json'))
            ? await loadPostWalkManifestState(
                rootDir,
                resolvePostWalkManifestLocales(),
                baseUrl,
                manifestProgress,
              )
            : {
                ok: false as const,
                reason: 'data/jobs.json missing: current manifest is incomplete',
              };
          if ('reason' in manifests) {
            // eslint-disable-next-line no-console
            console.warn(
              `[post-walk-coordinator][incremental] fallback=full reason=${manifests.reason}`,
            );
          } else {
            canPersistUnmanifestedInventory = true;
            manifestHtmlEntryCount = manifests.state.currentHtmlEntryCount;
            // This is the first line containing both cardinalities, and is
            // intentionally before dist enumeration and worker dispatch.
            // eslint-disable-next-line no-console
            console.log(
              `[post-walk-coordinator][incremental] previous=${manifests.state.previousEntryCount} `
                + `current=${manifests.state.currentEntryCount} phase=manifest-loaded`,
            );
            logBuildMem(
              'postWalkCoordinator: after-manifest',
              undefined,
              {
                previousEntries: manifests.state.previousEntryCount,
                currentEntries: manifests.state.currentEntryCount,
              },
              { forceGc: false },
            );
          }
          incrementalManifestPhaseMs = Date.now() - manifestStartedAt;
        }

        // ── Phase A: enumerate every emitted HTML file once ──────────
        const walkStartedAt = Date.now();
        const __tWalk = profileStart();
        const __tEnumeration = profileStart();
        const walkEnumerationStartedAt = Date.now();
        const currentClaimedPaths = [...getPathHistory().keys()];
        const persistedClaimedPaths = previousWalkInventory?.claimedPaths.map(
          (relative) => path.join(distDir, relative),
        ) ?? [];
        const claimedWalkPaths = [
          ...new Set([...persistedClaimedPaths, ...currentClaimedPaths]),
        ];
        const hasPersistedTargetRoots = previousWalkInventory !== null
          || previousUnmanifestedTopLevels !== null;
        const hasPersistedWalkPaths = previousWalkInventory !== null
          && previousWalkInventory.unmanifestedPaths.length > 0;
        const manifestAllowsTargetedWalk = manifests !== null
          && !('reason' in manifests)
          && !manifests.state.fallbackReason;
        const canUseTargetedWalk = incrementalEnabled
          && manifestAllowsTargetedWalk
          && hasPersistedTargetRoots
          && (claimedWalkPaths.length > 0 || hasPersistedWalkPaths);
        const indexedInventory: PostWalkIndexedInventory | undefined = previousWalkInventory
          ? {
            topLevels: previousWalkInventory.topLevels,
            unmanifestedPaths: previousWalkInventory.unmanifestedPaths,
          }
          : undefined;
        if (incrementalEnabled) {
          // eslint-disable-next-line no-console
          console.log(
            `[post-walk-coordinator][incremental] walk-input `
              + `inventory=${previousWalkInventory ? 'present' : 'missing'} `
              + `inventory-claimed=${previousWalkInventory?.claimedPaths.length ?? 0} `
              + `inventory-unmanifested=${previousWalkInventory?.unmanifestedPaths.length ?? 0} `
              + `legacy-top-levels=${previousUnmanifestedTopLevels?.length ?? 0} `
              + `path-history=${currentClaimedPaths.length} `
              + `manifests=${manifests === null ? 'missing' : 'loaded'}`,
          );
        }
        const walkResult = canUseTargetedWalk
          ? collectHtmlFromClaimedPaths(
            distDir,
            claimedWalkPaths,
            previousWalkInventory?.unmanifestedTopLevels
              ?? previousUnmanifestedTopLevels
              ?? [],
            indexedInventory,
          )
          : {
            paths: collectHtml(distDir, []),
            claimed: 0,
            targeted: 0,
            topLevels: listWalkableDistTopLevels(distDir),
            topLevelsChanged: false,
            indexed: 0,
        };
        const walkEnumerationMs = Date.now() - walkEnumerationStartedAt;
        profileRecord('walk-enumerate', __tEnumeration);
        const __tClassify = profileStart();
        const walkClassifyStartedAt = Date.now();
        const walkMode = canUseTargetedWalk ? 'claimed+targeted' : 'full';
        const walkClaimed = walkResult.claimed;
        const walkTargeted = walkResult.targeted;
        const allHtmlPaths = walkResult.paths;
        const filesScanned = allHtmlPaths.length;
        const existingHtmlSet = new Set<string>(allHtmlPaths);
        const manifestState = manifests !== null && !('reason' in manifests)
          ? manifests.state
          : null;
        canPersistUnmanifestedInventory = incrementalEnabled;
        let coveredHtmlPathCount = 0;
        const unmanifestedByTopLevel = new Map<string, number>();
        const unmanifestedPathsForInventory: string[] = [];
        const transformableUnmanifestedPaths: string[] = [];
        let processableCount = 0;
        let preEmittedFlatBridgesSkipped = 0;
        let nonOwnedLocaleSkipped = 0;
        const excludedHtmlPaths = incrementalEnabled && manifestState
          ? new Set<string>()
          : null;
        for (let index = 0; index < allHtmlPaths.length; index += 1) {
          const file = allHtmlPaths[index];
          // Per-locale matrix shard (BUILD_LOCALE): a file in a NON-owned
          // locale subtree is deleted, unread, by scripts/ci/prune-locale-shard.mjs
          // in the very next workflow step — it can never ship from this shard,
          // so reading + transforming + rewriting it is pure waste. On the `it`
          // shard of run 31036546298 that is ~600k of the 1,308,502 walked HTML
          // files; on an en/de/fr shard it is nearly the whole tree (prune keeps
          // ONLY `dist/<locale>` there). Same optimisation, same predicate and
          // same justification as blogImageCdnFinalizePlugin's `walk`.
          //
          // The file stays in `existingHtmlSet` (built from the FULL walk above)
          // so nothing that depends on knowing it exists changes:
          //  - transformHreflang's existence check for a cross-locale alternate
          //    is short-circuited anyway (`!shouldEmitLocale(ownerEmitLocale(l))
          //    → keep`, hreflangPostprocessPlugin.ts:115), so a non-owned target
          //    is kept UNCONDITIONALLY — it can never be dropped as broken;
          //  - transformFlatRedirect's sibling lookup only ever reads a sibling
          //    in the SAME directory, hence the same locale as the file itself.
          // shouldEmitPath returns true for ALL paths on the default all-locale
          // build (EMIT_ALL_LOCALES) → no-op, full coverage, byte-identical.
          if (!shouldEmitPath(file, distDir)) {
            nonOwnedLocaleSkipped++;
            excludedHtmlPaths?.add(file);
          } else {
            const preEmitted = isPreEmittedJobFlatBridgePath(distDir, file);
            let relative: string | null = null;
            if (manifestState) {
              const covered = postWalkManifestCoversHtmlPath(
                distDir,
                file,
                manifestState.current.entries,
              );
              if (covered) {
                coveredHtmlPathCount++;
              } else {
                relative = relativeDistPath(distDir, file);
                // A root-level file such as dist/404.html is an inventory
                // member, not a directory root. Encode it as <root> so the
                // next targeted walk does not try to readdir(dist/404.html).
                const relativeSegments = relative.split(path.sep);
                const topLevel = relativeSegments.length > 1
                  ? relativeSegments[0]
                  : '<root>';
                unmanifestedByTopLevel.set(
                  topLevel,
                  (unmanifestedByTopLevel.get(topLevel) ?? 0) + 1,
                );
                unmanifestedPathsForInventory.push(file);
                if (!preEmitted && isStaleKeywordLanding(landingPathFromDistRelative(relative))) {
                  transformableUnmanifestedPaths.push(file);
                }
              }
            } else {
              unmanifestedPathsForInventory.push(file);
            }
            if (preEmitted) {
              preEmittedFlatBridgesSkipped++;
              excludedHtmlPaths?.add(file);
              continue;
            }
            allHtmlPaths[processableCount] = file;
            processableCount++;
          }
        }
        allHtmlPaths.length = processableCount;
        const fullProcessHtmlPaths: readonly string[] = allHtmlPaths;
        processHtmlPaths = fullProcessHtmlPaths;
        const walkClassifyMs = Date.now() - walkClassifyStartedAt;
        profileRecord('walk-classify', __tClassify);
        profileRecord('walk-dist', __tWalk);
        const walkPhaseMs = Date.now() - walkStartedAt;
        if (incrementalEnabled) {
          logBuildMem(
            'postWalkCoordinator: after-walk',
            undefined,
            {
              scanned: filesScanned,
              processable: fullProcessHtmlPaths.length,
              walkMode,
              walkClaimed,
              walkTargeted,
            },
            { forceGc: false },
          );
        }

        if (incrementalEnabled) {
          const planStartedAt = Date.now();
          if (manifests === null || 'reason' in manifests) {
            const fallbackReason = manifests !== null && 'reason' in manifests
              ? manifests.reason
              : 'manifest loader returned no result';
            incrementalPlan = {
              mode: 'full',
              processHtmlPaths: fullProcessHtmlPaths,
              eligibleByManifest: 0,
              processed: fullProcessHtmlPaths.length,
              skippedUnchanged: 0,
              affected: 0,
              changed: 0,
              added: 0,
              removed: 0,
              fallbackReason,
              fallbackMode: 'full',
              reasonsByPath: new Map(),
            };
          } else {
            incrementalPlan = buildPostWalkIncrementalPlanFromState({
              distDir,
              allHtmlPaths: fullProcessHtmlPaths,
              processableHtmlPaths: fullProcessHtmlPaths,
              baseUrl,
              existingHtmlSet,
              excludedHtmlPaths: excludedHtmlPaths ?? undefined,
              coveredHtmlPathCount,
              // Once the deterministic sample verifier is on, unmanifested
              // producers are included in that sample and omitted from the
              // main dispatch. Without verification we keep the conservative
              // historical behaviour and process every uncovered file.
              includeUncoveredPaths: !postWalkIncrementalVerifyEnabled(),
              transformableUnmanifestedPaths,
              state: manifests.state,
            });
            processHtmlPaths = incrementalPlan.mode === 'incremental'
              ? incrementalPlan.processHtmlPaths
              : fullProcessHtmlPaths;
            if (incrementalPlan.fallbackReason) {
              // eslint-disable-next-line no-console
              console.warn(
                `[post-walk-coordinator][incremental] `
                  + `fallback=${incrementalPlan.fallbackMode ?? 'full'} `
                  + `reason=${incrementalPlan.fallbackReason}`,
              );
            }
            const changedKindCounts = new Map<string, number>();
            for (const logical of manifests.state.changed) {
              const kind = manifests.state.current.entries.get(logical)?.kind ?? '<missing>';
              changedKindCounts.set(kind, (changedKindCounts.get(kind) ?? 0) + 1);
            }
            changedByKind = [...changedKindCounts.entries()]
              .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
              .slice(0, 12)
              .map(([kind, count]) => `${kind}:${count}`)
              .join(',') || 'none';
            if (
              incrementalPlan.mode === 'incremental'
              && postWalkIncrementalVerifyEnabled()
            ) {
              verificationSamplePaths = selectPostWalkVerificationPaths(
                fullProcessHtmlPaths,
                postWalkIncrementalVerifySampleSize(),
                incrementalPlan.processHtmlPaths,
                false,
              );
              verificationSampleDetails = describePostWalkVerificationPaths({
                distDir,
                sampledPaths: verificationSamplePaths,
                incrementalProcessPaths: incrementalPlan.processHtmlPaths,
                state: manifests.state,
              });
            }
            logBuildMem(
              'postWalkCoordinator: after-plan',
              undefined,
              {
                mode: incrementalPlan.mode,
                previousEntries: manifests.state.previousEntryCount,
                currentEntries: manifests.state.currentEntryCount,
                processed: incrementalPlan.processed,
                changed: incrementalPlan.changed,
                added: incrementalPlan.added,
                removed: incrementalPlan.removed,
              },
              { forceGc: false },
            );
          }
          incrementalPlanPhaseMs = Date.now() - planStartedAt;
          // Explicitly drop the one current-entry map and delta sets before
          // blog maps, verification, or workers are allocated.
          if (manifests && !('reason' in manifests)) {
            releasePostWalkManifestState(manifests.state);
          }
          manifests = null;
          excludedHtmlPaths?.clear();
          if (incrementalPlan) {
            logBuildMem(
              'postWalkCoordinator: after-manifest-state-release',
              undefined,
              { mode: incrementalPlan.mode, processed: processHtmlPaths.length },
              { forceGc: true },
            );
          }
        }
        if (filesScanned === 0) {
          // eslint-disable-next-line no-console
          console.warn('[post-walk-coordinator] no HTML files in dist/ — skipping');
          return;
        }

        // ── Phase B: load blog-articles target map ONCE ──────────────
        const blogPhaseStartedAt = Date.now();
        const __tBlogLoad = profileStart();
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
        const dependencyHash = postWalkDependencyHash(existingHtmlSet, blogIndexHtmlByPath);
        profileRecord('load-blog-articles', __tBlogLoad);
        const blogPhaseMs = Date.now() - blogPhaseStartedAt;

        if (incrementalEnabled && incrementalPlan) {
          const derivedScope = prepareDerivedPostWalkScope({
            rootDir,
            distDir,
            paths: fullProcessHtmlPaths,
            existingHtmlSet,
            blogIndexHtmlByPath,
            dependencyHash,
            previous: previousDerivedSidecar,
          });
          derivedSidecarSkipped = incrementalPlan.mode === 'incremental'
            ? derivedScope.skippedPaths.size
            : 0;
          derivedSidecarProcessed = incrementalPlan.mode === 'incremental'
            ? derivedScope.processPaths.length
            : derivedScope.records.size;
          derivedRecordsForWrite = derivedScope.records;
          derivedSidecarReady = true;
          if (incrementalPlan.mode === 'incremental') {
            const selected = new Set(processHtmlPaths);
            for (const filePath of derivedScope.skippedPaths) selected.delete(filePath);
            for (const filePath of derivedScope.processPaths) selected.add(filePath);
            processHtmlPaths = [...selected];
            incrementalPlan = {
              ...incrementalPlan,
              processHtmlPaths,
              processed: processHtmlPaths.length,
              skippedUnchanged: Math.max(0, fullProcessHtmlPaths.length - processHtmlPaths.length),
            };
          }
        }

        if (
          incrementalEnabled
          && incrementalPlan?.mode === 'incremental'
          && postWalkIncrementalVerifyEnabled()
        ) {
          const verifyStartedAt = Date.now();
          const sampledPaths = verificationSamplePaths;
          const fullSampleDryRun = runSingleThreaded(
            sampledPaths,
            existingHtmlSet,
            blogIndexHtmlByPath,
            distDir,
            baseUrl,
            trimmedBase,
            false,
            true,
          );
          const comparison = comparePostWalkVerification({
            fullWouldWritePaths: fullSampleDryRun.wouldWritePaths ?? [],
            incrementalProcessPaths: processHtmlPaths,
            sampledPaths,
          });
          incrementalVerifyPhaseMs = Date.now() - verifyStartedAt;
          // eslint-disable-next-line no-console
          console.log(
            `[post-walk-coordinator][incremental-verify] sampled=${sampledPaths.length} `
              + `sample-only=${sampledPaths.length} forced=${processHtmlPaths.length} `
              + `would-write-but-skipped=${comparison.wouldWriteButSkipped.length} `
              + `processed-without-write=${comparison.processedButWouldNotWrite.length}`,
          );
          if (comparison.wouldWriteButSkipped.length > 0) {
            // Keep the first bounded sample in the marker so a canary exposes
            // the skipped class (manifest kind/top-level/dependency reason)
            // instead of only reporting a cardinality before falling back.
            // eslint-disable-next-line no-console
            console.warn(
              `[post-walk-coordinator][incremental-verify-mismatch-sample] `
                + `count=${comparison.wouldWriteButSkipped.length} `
                + formatVerificationMismatchSample(
                  comparison.wouldWriteButSkipped,
                  verificationSampleDetails,
                ),
            );
            const reason =
              `verify mismatch: ${comparison.wouldWriteButSkipped.length} full-write path(s) were skipped`;
            // eslint-disable-next-line no-console
            console.warn(`[post-walk-coordinator][incremental] fallback=full reason=${reason}`);
            incrementalPlan = {
              ...incrementalPlan,
              mode: 'full',
              processHtmlPaths: fullProcessHtmlPaths,
              processed: fullProcessHtmlPaths.length,
              skippedUnchanged: 0,
              affected: 0,
              fallbackReason: reason,
              fallbackMode: 'full',
            };
            processHtmlPaths = fullProcessHtmlPaths;
          }
          logBuildMem(
            'postWalkCoordinator: after-verify',
            undefined,
            {
              sampled: sampledPaths.length,
              sampleOnly: sampledPaths.length,
              forced: processHtmlPaths.length,
              processed: processHtmlPaths.length,
              mismatch: comparison.wouldWriteButSkipped.length,
            },
            { forceGc: false },
          );
        }

        // ── Phase C: dispatch work ─────────────────────────────────
        const processPhaseStartedAt = Date.now();
        const workerCount = resolveWorkerCount(processHtmlPaths.length);
        const merged: WorkerResult =
          workerCount <= 1
            ? runSingleThreaded(
                processHtmlPaths,
                existingHtmlSet,
                blogIndexHtmlByPath,
                distDir,
                baseUrl,
                trimmedBase,
              )
            : await (async () => {
                const __tChunk = profileStart();
                const chunks = chunkRoundRobin(processHtmlPaths, workerCount);
                profileRecord('chunk-roundrobin', __tChunk);
                const workerUrl = new URL('./postWalkWorker.mjs', import.meta.url);
                const blogIndexEntries = Array.from(blogIndexHtmlByPath.entries());
                const keywordLandingPlan = getKeywordLandingPlanSnapshot();
                const __tHtmlIndex = profileStart();
                const htmlPathIndex = buildSharedHtmlPathIndex(existingHtmlSet);
                profileRecord('shared-html-path-index', __tHtmlIndex);
                const __tDispatch = profileStart();
                const finalMerged = emptyWorkerResult();
                await Promise.all(
                  chunks.map(async (assignedFiles) => {
                    const r = await runInWorker(workerUrl, {
                      distDir,
                      baseUrl,
                      trimmedBase,
                      blogIndexEntries,
                      contextualLinkDefaults: contextualLinkDefaults(),
                      assignedFiles,
                      htmlPathIndex,
                      keywordLandingPlan,
                    });
                    if (r.profilerBuckets && r.profilerBuckets.length > 0) {
                      profileIngestBuckets(r.profilerBuckets);
                    }
                    const __tMerge = profileStart();
                    mergeResultInto(finalMerged, r);
                    profileRecord('merge-results', __tMerge);
                  }),
                );
                profileRecord('worker-dispatch', __tDispatch);
                return finalMerged;
              })();
        const processPhaseMs = Date.now() - processPhaseStartedAt;

        if (incrementalEnabled) {
          logBuildMem(
            'postWalkCoordinator: after-process',
            undefined,
            { processed: processHtmlPaths.length, writes: merged.totalWrites },
            { forceGc: false },
          );
        }

        if (incrementalEnabled && derivedSidecarReady) {
          const recordsWithoutFailures = filterPostWalkDerivedDigestRecords(
            derivedRecordsForWrite,
            distDir,
            merged.writeFailures,
          );
          writePostWalkDerivedDigestSidecar(rootDir, recordsWithoutFailures);
        }
        if (incrementalEnabled && incrementalPlan && canPersistUnmanifestedInventory) {
          const inventoryUnmanifestedTopLevels = new Set(unmanifestedByTopLevel.keys());
          for (const filePath of unmanifestedPathsForInventory) {
            const relative = relativeDistPath(distDir, filePath).split(path.sep).join('/');
            inventoryUnmanifestedTopLevels.add(relative.split('/', 1)[0] || '<root>');
          }
          await writePostWalkWalkInventory(rootDir, distDir, {
            topLevels: walkResult.topLevels,
            unmanifestedTopLevels: inventoryUnmanifestedTopLevels,
            claimedPaths: claimedWalkPaths,
            unmanifestedPaths: unmanifestedPathsForInventory,
          });
          // Keep the v1 top-level cache for older runners and for a bounded
          // fallback when the exact path index is unavailable.
          writePostWalkUnmanifestedTopLevels(rootDir, inventoryUnmanifestedTopLevels);
        }

        for (const f of merged.writeFailures) {
          // eslint-disable-next-line no-console
          console.warn(`[post-walk-coordinator] failed to write ${f.filePath}: ${f.msg}`);
        }

        const dur = ((Date.now() - startTotal) / 1000).toFixed(2);
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[36m[post-walk-coordinator]\x1b[0m scanned ${filesScanned} files in ${dur}s ` +
            `(workers: ${workerCount}, processed ${processHtmlPaths.length}, ` +
            `${nonOwnedLocaleSkipped} non-owned-locale skipped) — ` +
            `bridges: ${merged.bridgeConverted + preEmittedFlatBridgesSkipped} converted ` +
            `(${preEmittedFlatBridgesSkipped} pre-skipped, ${merged.bridgeSkipped} non-bridge skipped), ` +
            `blog: ${merged.blogArticlesModified} modified / ${merged.blogLinksInjected} links injected, ` +
            `hreflang: ${merged.hreflangFilesRewritten} rewritten / ${merged.hreflangLinksKept} kept / ${merged.hreflangLinksDropped} dropped, ` +
            `total writes: ${merged.totalWrites}`,
        );

        if (incrementalEnabled && incrementalPlan) {
          const unmanifestedTopLevel = [...unmanifestedByTopLevel.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 12)
            .map(([topLevel, count]) => `${topLevel}:${count}`)
            .join(',');
          // eslint-disable-next-line no-console
          console.log(
            `[post-walk-coordinator][incremental] scanned=${filesScanned} `
              + `eligible-by-manifest=${incrementalPlan.eligibleByManifest} `
              + `manifest-html-entries=${manifestHtmlEntryCount} `
              + `mode=${incrementalPlan.mode} `
              + `changed-entries=${incrementalPlan.changed} added-entries=${incrementalPlan.added} removed-entries=${incrementalPlan.removed} `
              + `changed-by-kind=${changedByKind} `
              + `processed=${processHtmlPaths.length} `
              + `skipped-unchanged=${incrementalPlan.skippedUnchanged} `
              + `unmanifested=${incrementalPlan.unmanifested ?? 'n/a'} `
              + `transformable-unmanifested=${transformableUnmanifestedPaths.length} `
              + `unmanifested-skipped=${incrementalPlan.unmanifestedSkipped ?? 'n/a'} `
              + `walk=${walkMode} walk-claimed=${walkClaimed} walk-targeted=${walkTargeted} `
              + `walk-enumerate-ms=${walkEnumerationMs} walk-classify-ms=${walkClassifyMs} `
              + `walk-indexed=${walkResult.indexed} walk-top-levels-changed=${walkResult.topLevelsChanged} `
              + `unmanifested-top-level=${unmanifestedTopLevel || 'none'} `
              + `derived-sidecar=${derivedSidecarRecords}/${derivedSidecarSkipped}/${derivedSidecarProcessed} `
              + `affected=${incrementalPlan.affected} `
              + `writes=${merged.totalWrites} `
              + `fallback=${incrementalPlan.fallbackMode
                ? `${incrementalPlan.fallbackMode}:${incrementalPlan.fallbackReason ?? 'unspecified'}`
                : 'none'} `
              + `phases_ms=walk:${walkPhaseMs},manifest:${incrementalManifestPhaseMs},`
              + `plan:${incrementalPlanPhaseMs},`
              + `blog:${blogPhaseMs},process:${processPhaseMs},verify:${incrementalVerifyPhaseMs} `
              + `dependency-rule="${POST_WALK_INCREMENTAL_DEPENDENCY_RULE}"`,
          );
        }

        // Unified [post-walk-profile] summary table. No-op when the profiler
        // is gated off. Mirrors the jobs-seo / related-search summary so the
        // workflow's Build profile summary step can grep+sed it identically.
        printPostWalkProfile();
      },
    },
  };
}
