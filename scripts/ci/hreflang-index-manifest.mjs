#!/usr/bin/env node
/**
 * hreflang-index-manifest — build this shard's hreflang index manifest and
 * keep only reciprocal hreflang clusters of indexable, self-canonical pages.
 *
 * Contract and rationale: scripts/lib/hreflang-index-manifest.mjs.
 *
 * Where it runs: every deploy.yml `build-locale` leg runs the dry pass after
 * `prune-locale-shard.mjs` to publish its own manifest. IT performs the rewrite
 * there before producing Pages; non-IT source artifacts defer the same rewrite
 * to deploy-publish.yml, after all four same-run manifests are available.
 *
 * Inputs
 *   - `dist/`, the final HTML of the locales this leg owns (`BUILD_LOCALE`,
 *     all four when unset): judged against THIS run's manifest, exactly.
 *   - `<manifest-dir>/<locale>.json` for every locale this leg does NOT own:
 *     the manifest another leg published, downloaded by
 *     exchange-hreflang-manifests.mjs. When one is missing or invalid,
 *     alternates into that locale are not judged — the behaviour before this
 *     step — and the summary says so, unless --require-foreign-manifests.
 *
 * Outputs
 *   - `<manifest-dir>/<locale>.json` for every owned locale (published as an
 *     artifact by the workflow for the other legs of the same run).
 *   - Rewritten HTML (unless `--dry-run`), written only after EVERY decision
 *     has been made. Writes use bounded batches, one in flight per write
 *     worker, and a failed write rolls back its own batch. After a failure no
 *     new batch starts and the step fails only once the batches in flight have
 *     settled. Other batches can be rewritten locally, but a failed workflow
 *     step cannot upload that partial `dist/`.
 *   - One summary line `[hreflang-index-manifest] {...}` with every counter,
 *     `pagesDeferred` (heads read a second time), `phaseMs` (walk, pass1,
 *     pass2, write, manifest), `writeDetail` (write workers and the time
 *     summed over them in stage, commit and cleanup) and `memoryMB` at the
 *     end of the run.
 *
 * Reads: each owned page head is read ONCE per run of this CLI. With a reused
 * pre-pass cache, only the blocks that need a manifest are read again: a strip
 * decided from the page alone travels in the cache. Pass 1 also decides every block
 * whose members are judged only by foreign manifests (the whole deferred
 * non-IT publish leg); only a block that needs this run's own manifest is
 * read again after the scan. Nothing extra is kept per page — see the pass-1
 * comment and the heap guard in tests/hreflang-index-manifest.test.ts.
 *
 * Usage:
 *   node scripts/ci/hreflang-index-manifest.mjs [distDir]
 *     [--manifest-dir .cache/hreflang-index-manifest] [--dry-run]
 *     [--manifest-only]
 *     [--prepass-cache <path> | --reuse-prepass-cache <path>]
 *     [--require-foreign-manifests]
 *     [--base-url https://frontaliereticino.ch] [--concurrency 64]
 *     [--write-workers 8]
 *
 * This file is also the entry point of its own write workers, and it must stay
 * the only file of the write path: post-build-matrix-test.yml overlays this
 * file alone on an older source commit to measure it on a real IT shard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readHeadOrAll } from '../lib/readHead.mjs';
import { distFileToUrlPath } from '../lib/externally-served-paths.mjs';
import {
  DEFAULT_BASE_URL,
  MANIFEST_LOCALES,
  applyHreflangDecision,
  classifyHreflangPage,
  decideHreflangBlock,
  localeOfPath,
  parseHreflangManifest,
  serializeHreflangManifest,
} from '../lib/hreflang-index-manifest.mjs';

const SKIP_DIRS = new Set(['assets', 'data', 'images']);
export const HREFLANG_REWRITE_BATCH_SIZE = 64;
/**
 * Threads running the rewrite transactions. Each one issues synchronous fs
 * calls, so this is also the most disk requests the write pass has in flight.
 * It is not tied to the CPU count on purpose: a thread blocked on the disk uses
 * no CPU. The parallelism is what pays: ONE worker measured slower than the
 * former `fs.promises` code on a lightly loaded Mac (0.79x), while 4, 8 and 16
 * were within noise of each other there, on a warm cache. 8 doubles the four
 * requests libuv allowed, for the runner's cold reads; compare on CI with
 * `--write-workers` and the `write` / `writeDetail` fields of the summary
 * (scripts/dev/bench-hreflang-write.mjs for a local comparison).
 */
export const HREFLANG_WRITE_WORKERS = 8;
const WRITE_WORKER_ROLE = 'hreflang-rewrite';
const HREFLANG_PREPASS_CACHE_VERSION = 2;
/**
 * The strips `decideHreflangBlock` returns before it asks any manifest: they
 * depend on the page alone, so the pre-barrier pass can settle them and the
 * final pass need not read those heads again.
 */
const PAGE_ONLY_STRIP_REASONS = new Set([
  'page-noindex',
  'page-canonical-elsewhere',
  'page-not-member',
  'duplicate-hreflang',
  'incomplete-locale-set',
]);

export function ownedLocalesFromEnv(raw = process.env.BUILD_LOCALE) {
  const wanted = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((l) => MANIFEST_LOCALES.includes(l));
  return wanted.length > 0 ? [...new Set(wanted)] : MANIFEST_LOCALES.slice();
}

/**
 * Yield every HTML page under `dir` (serial walk, same order as before).
 *
 * Also answers, without a Map over every page, the one question that used to
 * need one — which of `foo.html` and `foo/index.html` is the primary document
 * of `/foo`: a flat `X.html` is shadowed exactly when the SAME directory holds
 * a walked subdirectory `X` (not a skipped one, not a symlink) whose
 * `index.html` is a regular file, i.e. when this walk also yields
 * `X/index.html`. Those rare flat files are added to `shadowed`; the directory
 * index wins, as before.
 *
 * Deliberately serial: a concurrent walk was measured (+170 B/page of live
 * heap on a 24k-page dist) to hold the whole directory frontier at once, which
 * on a 2.5M-page locale is the kind of heap growth this step cannot afford.
 */
function* walkHtml(dir, shadowed) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read HTML directory ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  // Stems of the flat pages of this directory that have a walked twin
  // directory. Sized by the flat pages, not by the (possibly huge) listing.
  let flatStems = null;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== 'index.html') {
      (flatStems ??= new Set()).add(entry.name.slice(0, -'.html'.length));
    }
  }
  let twinDirs = null;
  if (flatStems !== null) {
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && flatStems.has(entry.name)) (twinDirs ??= new Set()).add(entry.name);
    }
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkHtml(p, shadowed);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      if (entry.name !== 'index.html' && twinDirs?.has(entry.name.slice(0, -'.html'.length))) {
        let index = null;
        try {
          index = fs.lstatSync(path.join(p.slice(0, -'.html'.length), 'index.html'));
        } catch {
          // No directory index: the flat file is the primary document.
        }
        if (index?.isFile()) shadowed.add(p);
      }
      yield p;
    }
  }
}

async function writePrepassCache(cachePath, {
  distDir,
  ownedLocales,
  runId,
  pagesScanned,
  pagesByReason,
  withHreflang,
  manifestCounts,
}) {
  const target = path.resolve(cachePath);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const output = fs.createWriteStream(temp, { encoding: 'utf-8' });

  try {
    const header = {
      kind: 'header',
      version: HREFLANG_PREPASS_CACHE_VERSION,
      ownedLocales,
      runId,
      pagesScanned,
      pagesByReason,
      recordCount: withHreflang.length,
      manifestCounts,
    };
    output.write(`${JSON.stringify(header)}\n`);
    for (const item of withHreflang) {
      const record = {
        file: path.relative(distDir, item.file),
        urlPath: item.urlPath,
        ...(item.pageOnlyStrip ? { pageOnlyStrip: item.pageOnlyStrip } : {}),
      };
      if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
    await fs.promises.rename(temp, target);
  } catch (error) {
    output.destroy();
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readPrepassCache(cachePath, {
  distDir,
  manifestDir,
  ownedLocales,
  runId,
}) {
  const root = path.resolve(distDir);
  const owned = new Set(ownedLocales);
  const current = new Map(MANIFEST_LOCALES.map((locale) => [locale, new Map()]));
  const manifestCounts = {};

  for (const locale of owned) {
    const manifestPath = path.join(manifestDir, `${locale}.json`);
    const parsed = parseHreflangManifest(fs.readFileSync(manifestPath, 'utf-8'), locale);
    if ('error' in parsed) throw new Error(`prepass manifest ${locale} invalid: ${parsed.error}`);
    if ((parsed.runId || '') !== (runId || '')) {
      throw new Error(`prepass manifest ${locale} belongs to run ${parsed.runId || '(empty)'}, expected ${runId || '(empty)'}`);
    }
    manifestCounts[locale] = parsed.entries.size;
    current.set(locale, parsed.entries);
  }

  const input = fs.createReadStream(cachePath, { encoding: 'utf-8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const withHreflang = [];
  let header = null;

  for await (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid hreflang prepass cache JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (header === null) {
      header = record;
      continue;
    }
    if (typeof record.file !== 'string' || typeof record.urlPath !== 'string') {
      throw new Error('invalid hreflang prepass cache record');
    }
    const file = path.resolve(root, record.file);
    if (file === root || !file.startsWith(`${root}${path.sep}`)) {
      throw new Error(`hreflang prepass path escapes dist: ${record.file}`);
    }
    if (!owned.has(localeOfPath(record.urlPath))) {
      throw new Error(`hreflang prepass contains an unowned locale path: ${record.urlPath}`);
    }
    const { pageOnlyStrip } = record;
    if (pageOnlyStrip !== undefined && !PAGE_ONLY_STRIP_REASONS.has(pageOnlyStrip)) {
      throw new Error(`invalid hreflang prepass strip reason: ${pageOnlyStrip}`);
    }
    withHreflang.push({ file, urlPath: record.urlPath, pageOnlyStrip });
  }

  if (
    header?.kind !== 'header'
    || header.version !== HREFLANG_PREPASS_CACHE_VERSION
    || JSON.stringify(header.ownedLocales) !== JSON.stringify(ownedLocales)
    || (header.runId || '') !== (runId || '')
    || !Number.isSafeInteger(header.pagesScanned)
    || !Number.isSafeInteger(header.recordCount)
    || header.recordCount !== withHreflang.length
    || !header.pagesByReason
    || typeof header.pagesByReason !== 'object'
    || Array.isArray(header.pagesByReason)
  ) {
    throw new Error('hreflang prepass cache header is missing or incompatible');
  }
  for (const locale of owned) {
    if (header.manifestCounts?.[locale] !== manifestCounts[locale]) {
      throw new Error(`prepass manifest count mismatch for ${locale}`);
    }
  }

  return {
    current,
    pagesScanned: header.pagesScanned,
    pagesByReason: header.pagesByReason,
    withHreflang,
  };
}

async function mapPool(items, concurrency, fn) {
  let cursor = 0;
  let failed = false;
  let firstError;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      if (failed) return;
      const index = cursor++;
      try {
        await fn(items[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
    }
  });
  await Promise.all(lanes);
  if (failed) throw firstError;
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function normaliseRewriteBatchSize(value) {
  if (value === Number.POSITIVE_INFINITY) return value;
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.floor(number))
    : HREFLANG_REWRITE_BATCH_SIZE;
}

/**
 * Compare the logical bytes duplicated by the old single-transaction rewrite
 * with the bytes duplicated by bounded batches, on the exact same files.
 * The old implementation staged every changed HTML file before its first
 * rename, so its peak is the sum of original + staged bytes for all records.
 * With several batches in flight the peak is bounded by the largest
 * `parallelBatches` of them taken together.
 */
export function benchmarkHreflangStaging(records, batchSize = HREFLANG_REWRITE_BATCH_SIZE, parallelBatches = 1) {
  const size = normaliseRewriteBatchSize(batchSize);
  const preBatchPeakBytes = records.reduce(
    (total, record) => total + record.originalBytes + record.stagedBytes,
    0,
  );
  const batchTotals = [];
  for (let offset = 0; offset < records.length; offset += size) {
    const batch = records.slice(offset, offset + size);
    batchTotals.push(batch.reduce(
      (total, record) => total + record.originalBytes + record.stagedBytes,
      0,
    ));
  }
  const peakStagingBytes = batchTotals
    .sort((a, b) => b - a)
    .slice(0, Math.max(1, parallelBatches))
    .reduce((total, bytes) => total + bytes, 0);
  return {
    phase: 'build-locale:hreflang-index-manifest',
    inputFiles: records.length,
    batchSize: Number.isFinite(size) ? size : 'unbounded',
    parallelBatches: Math.max(1, parallelBatches),
    preBatchPeakBytes,
    peakStagingBytes,
    reductionBytes: preBatchPeakBytes - peakStagingBytes,
  };
}

/**
 * Rewrite one batch as a transaction: stage every changed page, then install
 * them one by one behind a backup, and drop the backups only once the whole
 * batch is installed.
 *
 * Synchronous on purpose. Through `fs.promises` each file cost about a dozen
 * round trips between the event loop and libuv's four threads, and the two
 * renames of every file were awaited one at a time. Parallelism comes from
 * running several of these transactions in worker threads.
 */
function rewriteBatchSync(distDir, batch) {
  const startedAt = performance.now();
  let stageEnd = startedAt;
  let commitEnd = startedAt;
  // The temp dir lives under `dist/` so staged files and page files share a
  // filesystem.
  const transactionDir = fs.mkdtempSync(path.join(distDir, '.hreflang-index-'));
  const staged = [];
  const moved = [];
  try {
    for (let index = 0; index < batch.length; index++) {
      const { file, decision } = batch[index];
      // One read gives both the text and the on-disk size the staging
      // benchmark needs (a regular file's size is its byte length).
      const original = fs.readFileSync(file);
      const next = applyHreflangDecision(original.toString('utf-8'), decision);
      if (next === null) continue;
      const stagedFile = path.join(transactionDir, String(index));
      fs.writeFileSync(stagedFile, next, 'utf-8');
      staged.push({ file, stagedFile, originalBytes: original.length, stagedBytes: Buffer.byteLength(next, 'utf-8') });
    }
    stageEnd = performance.now();

    const transactionId = path.basename(transactionDir);
    try {
      for (const item of staged) {
        const backup = `${item.file}.${transactionId}.bak`;
        fs.renameSync(item.file, backup);
        const record = { file: item.file, backup, installed: false };
        moved.push(record);
        fs.renameSync(item.stagedFile, item.file);
        record.installed = true;
      }
    } catch (error) {
      for (const item of [...moved].reverse()) {
        try {
          if (item.installed) fs.rmSync(item.file, { force: true });
          fs.renameSync(item.backup, item.file);
        } catch {
          // Preserve the original failure; the workflow remains fail-closed.
        }
      }
      throw error;
    }
    commitEnd = performance.now();
    for (const item of moved) fs.rmSync(item.backup, { force: true });
  } finally {
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
  return {
    records: staged.map(({ originalBytes, stagedBytes }) => ({ originalBytes, stagedBytes })),
    stageMs: stageEnd - startedAt,
    commitMs: commitEnd - stageEnd,
    cleanupMs: performance.now() - commitEnd,
  };
}

function serveRewriteWorker({ distDir }) {
  parentPort.on('message', (batch) => {
    try {
      parentPort.postMessage({ result: rewriteBatchSync(distDir, batch) });
    } catch (error) {
      parentPort.postMessage({ error });
    }
  });
}

/** Send one batch to an idle worker and wait for its outcome. */
function rewriteInWorker(worker, batch) {
  return new Promise((resolve, reject) => {
    const settle = (done, value) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      done(value);
    };
    const onMessage = ({ result, error }) => (error ? settle(reject, error) : settle(resolve, result));
    const onError = (error) => settle(reject, error);
    const onExit = (code) => settle(reject, new Error(`hreflang write worker exited with code ${code} during a batch`));
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(batch);
  });
}

/**
 * Run every batch, `workers` at a time (`0` = on this thread). After the first
 * failure no new batch starts, and the rejection is raised only once every
 * batch in flight has settled: nothing mutates `dist/` after this returns.
 */
async function rewriteChanges({ distDir, changes, batchSize, workers }) {
  const results = [];
  let cursor = 0;
  let failure = null;
  const lane = async () => {
    let worker = null;
    try {
      while (failure === null && cursor < changes.length) {
        const offset = cursor;
        cursor += batchSize;
        const batch = changes.slice(offset, offset + batchSize);
        if (workers === 0) {
          results.push({ offset, ...rewriteBatchSync(distDir, batch) });
          continue;
        }
        // execArgv emptied: the worker loads this file and must not inherit
        // flags of the parent that only fit its own entry (`--input-type`).
        worker ??= new Worker(new URL(import.meta.url), { execArgv: [], workerData: { role: WRITE_WORKER_ROLE, distDir } });
        results.push({ offset, ...await rewriteInWorker(worker, batch) });
      }
    } catch (error) {
      failure ??= { error };
    } finally {
      await worker?.terminate();
    }
  };
  const lanes = Math.min(Math.max(1, workers), Math.ceil(changes.length / batchSize));
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure !== null) throw failure.error;
  // Batches settle out of order; restore the input order so the same-input
  // staging benchmark measures the groups that were on disk together.
  results.sort((a, b) => a.offset - b.offset);
  const sum = (key) => Math.round(results.reduce((total, result) => total + result[key], 0));
  return {
    records: results.flatMap((result) => result.records),
    detail: {
      workers: workers === 0 ? 0 : lanes,
      batches: results.length,
      stageMs: sum('stageMs'),
      commitMs: sum('commitMs'),
      cleanupMs: sum('cleanupMs'),
    },
  };
}

function normaliseWriteWorkers(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : HREFLANG_WRITE_WORKERS;
}

/**
 * Run the manifest pass. Exported for tests; the CLI below wraps it.
 */
export async function runHreflangIndexManifest({
  distDir,
  manifestDir,
  ownedLocales = MANIFEST_LOCALES.slice(),
  baseUrl = DEFAULT_BASE_URL,
  dryRun = false,
  manifestOnly = false,
  requireForeignManifests = false,
  prepassCachePath = null,
  reusePrepassCachePath = null,
  concurrency = 64,
  runId = process.env.GITHUB_RUN_ID || '',
  rewriteBatchSize = HREFLANG_REWRITE_BATCH_SIZE,
  writeWorkers = HREFLANG_WRITE_WORKERS,
  log = (line) => console.log(line),
}) {
  if (manifestOnly && !dryRun) throw new Error('--manifest-only requires --dry-run');
  const batchSize = normaliseRewriteBatchSize(rewriteBatchSize);
  const owned = new Set(ownedLocales);
  let files = [];
  let current = new Map(MANIFEST_LOCALES.map((l) => [l, new Map()]));
  let pagesByReason = {};
  let withHreflang = [];
  let pagesScanned = 0;
  let prepassCache = 'unused';
  let shadowed = new Set();
  const readFailures = [];
  const startedAt = performance.now();
  const phaseMs = {};
  let phaseStart = startedAt;
  const elapsed = () => {
    const now = performance.now();
    const ms = Math.round(now - phaseStart);
    phaseStart = now;
    return ms;
  };

  if (reusePrepassCachePath) {
    try {
      ({ current, pagesScanned, pagesByReason, withHreflang } = await readPrepassCache(reusePrepassCachePath, {
        distDir,
        manifestDir,
        ownedLocales,
        runId,
      }));
      prepassCache = 'reused';
    } catch (error) {
      prepassCache = 'fallback';
      log(`::warning title=hreflang prepass cache unavailable::${error instanceof Error ? error.message : String(error)}; scanning dist again`);
    }
    phaseMs.prepassRead = elapsed();
  }

  // ── Manifests of the locales this leg does not own ───────────────────────
  // Read BEFORE pass 1 so that pass 1 can already decide every block whose
  // members it can judge without this run's own manifest (see below), and so
  // a missing required manifest fails before the dist is scanned.
  const foreign = new Map();
  const manifestSources = {};
  const foreignManifestFailures = [];
  for (const locale of MANIFEST_LOCALES) {
    if (owned.has(locale)) {
      manifestSources[locale] = 'this-run';
      continue;
    }
    const file = path.join(manifestDir, `${locale}.json`);
    if (!fs.existsSync(file)) {
      manifestSources[locale] = 'missing';
      foreignManifestFailures.push(`${locale}: missing`);
      continue;
    }
    const parsed = parseHreflangManifest(fs.readFileSync(file, 'utf-8'), locale);
    if ('error' in parsed) {
      manifestSources[locale] = `invalid: ${parsed.error}`;
      foreignManifestFailures.push(`${locale}: ${parsed.error}`);
      continue;
    }
    foreign.set(locale, parsed.entries);
    manifestSources[locale] = `run ${parsed.runId || '?'} (${parsed.entries.size} entries)`;
  }
  if (requireForeignManifests && foreignManifestFailures.length > 0) {
    throw new Error(`required foreign hreflang manifests missing or invalid after barrier: ${foreignManifestFailures.join(', ')}`);
  }

  const lookup = (locale, urlPath) => {
    const entries = owned.has(locale) ? current.get(locale) : foreign.get(locale);
    if (!entries) return { status: 'unknown', reason: `no-manifest-${locale}` };
    const key = entries.get(urlPath);
    return key === undefined ? { status: 'absent' } : { status: 'eligible', key };
  };

  const blocksByDecision = {};
  const unknownMembers = {};
  const changes = [];
  const recordDecision = (item, decision) => {
    bump(blocksByDecision, `${decision.action}:${decision.reason}`);
    for (const reason of decision.unknown) bump(unknownMembers, reason);
    if (decision.action === 'strip' || decision.xDefault !== null) {
      changes.push({ file: item.file, decision: { action: decision.action, reason: decision.reason, xDefault: decision.xDefault } });
    }
  };

  // Pages whose block cannot be decided in pass 1 and are read again in pass 2.
  let deferred = [];
  if (prepassCache !== 'reused') {
    files = [];
    for (const file of walkHtml(distDir, shadowed)) {
      const urlPath = distFileToUrlPath(file, distDir);
      if (urlPath === null) continue;
      if (!owned.has(localeOfPath(urlPath))) continue;
      files.push({ file, urlPath });
    }
    phaseMs.walk = elapsed();

    // ── Pass 1: classify every owned page from its head ───────────────────
    // Only what the decision needs survives the pass: the manifest entry of
    // an eligible page, the PATH of a page carrying hreflang and, for a page
    // whose block is already decidable, its (small) rewrite decision.
    //
    // A block is decidable here when deciding it never asks THIS run's
    // manifest — still being built by this very pass — about a member:
    // `decideHreflangBlock` is pure, and the foreign manifests are complete
    // and immutable, so the decision equals the one pass 2 would take after
    // the full scan. A non-IT publish leg owns one locale and its pages list
    // themselves as their only owned member, so every block is decided here
    // and the second read of ~1.2M heads disappears. A block that does ask
    // the own manifest is deferred and re-read after the scan, exactly as
    // before. Nothing is accumulated per page beyond what pass 2 kept.
    await mapPool(files, concurrency, async (item) => {
      const head = await readHeadOrAll(item.file);
      if (head === null) {
        readFailures.push(item.file);
        return;
      }
      const page = classifyHreflangPage(head, item.urlPath, { baseUrl });
      bump(pagesByReason, page.reason);
      if (page.eligible && !shadowed.has(item.file)) {
        current.get(localeOfPath(page.path)).set(item.urlPath, page.clusterKey);
      }
      if (!page.hasHreflang) return;
      withHreflang.push(item);
      let askedManifest = false;
      let needsOwnManifest = false;
      const decision = decideHreflangBlock(page, (locale, urlPath) => {
        askedManifest = true;
        if (owned.has(locale)) {
          needsOwnManifest = true;
          return { status: 'unknown', reason: 'deferred' };
        }
        return lookup(locale, urlPath);
      });
      if (manifestOnly) {
        // No decision is final here unless it never asked a manifest: the
        // foreign ones are not available before the barrier.
        if (!askedManifest && decision.action === 'strip') item.pageOnlyStrip = decision.reason;
        return;
      }
      if (needsOwnManifest) deferred.push(item);
      else recordDecision(item, decision);
    });
    if (readFailures.length > 0) {
      throw new Error(`${readFailures.length} HTML file(s) unreadable, first: ${readFailures[0]}`);
    }
    pagesScanned = files.length;
    phaseMs.pass1 = elapsed();
  } else {
    // Settled by the pre-pass from the page alone (see
    // PAGE_ONLY_STRIP_REASONS); no step mutates dist in between.
    for (const item of withHreflang) {
      if (item.pageOnlyStrip === undefined) deferred.push(item);
      else recordDecision(item, { action: 'strip', reason: item.pageOnlyStrip, xDefault: null, unknown: [] });
    }
  }

  // ── Pass 2: decide the remaining blocks before touching any file ────────
  if (!manifestOnly) {
    await mapPool(deferred, concurrency, async (item) => {
      const head = await readHeadOrAll(item.file);
      if (head === null) {
        readFailures.push(item.file);
        return;
      }
      const page = classifyHreflangPage(head, item.urlPath, { baseUrl });
      recordDecision(item, decideHreflangBlock(page, lookup));
    });
    if (readFailures.length > 0) {
      throw new Error(`${readFailures.length} HTML file(s) unreadable in pass 2, first: ${readFailures[0]}`);
    }
  }
  const pagesDeferred = manifestOnly ? 0 : deferred.length;
  deferred = [];
  phaseMs.pass2 = elapsed();

  // ── Pass 3: write ──────────────────────────────────────────────────────
  // At most one bounded batch of duplicate HTML per write worker is on disk.
  // A failed batch rolls back its own renames; a failure fails this workflow
  // step, so the partially rewritten local dist is never packed or uploaded.
  let filesRewritten = 0;
  let stagingRecords = [];
  let writeDetail = null;
  const parallelBatches = Math.max(1, normaliseWriteWorkers(writeWorkers));
  if (!dryRun) {
    ({ records: stagingRecords, detail: writeDetail } = await rewriteChanges({
      distDir,
      changes,
      batchSize: Number.isFinite(batchSize) ? batchSize : Math.max(1, changes.length),
      workers: normaliseWriteWorkers(writeWorkers),
    }));
    filesRewritten = stagingRecords.length;
  }

  phaseMs.write = elapsed();

  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestCounts = {};
  for (const locale of owned) {
    const entries = current.get(locale);
    manifestCounts[locale] = entries.size;
    const target = path.join(manifestDir, `${locale}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, serializeHreflangManifest({ locale, entries, runId }));
    fs.renameSync(tmp, target);
  }

  if (dryRun && prepassCachePath) {
    try {
      await writePrepassCache(prepassCachePath, {
        distDir,
        ownedLocales,
        runId,
        pagesScanned,
        pagesByReason,
        withHreflang,
        manifestCounts,
      });
      prepassCache = 'written';
    } catch (error) {
      prepassCache = 'write-failed';
      log(`::warning title=hreflang prepass cache write failed::${error instanceof Error ? error.message : String(error)}; final pass will scan dist again`);
    }
  }

  phaseMs.manifest = elapsed();
  phaseMs.total = Math.round(performance.now() - startedAt);
  const memory = process.memoryUsage();

  const stagingBenchmark = dryRun ? null : benchmarkHreflangStaging(stagingRecords, batchSize, parallelBatches);
  const summary = {
    owned: [...owned],
    dryRun,
    manifestOnly,
    pagesScanned,
    pagesByReason,
    pagesWithHreflang: withHreflang.length,
    pagesDeferred,
    prepassCache,
    blocksByDecision,
    unknownMembers,
    manifestSources,
    manifestCounts,
    filesToRewrite: changes.length,
    filesRewritten,
    stagingBenchmark,
    stagingBytes: stagingBenchmark === null ? null : {
      allAtOnceEquivalent: stagingBenchmark.preBatchPeakBytes,
      boundedBatchPeak: stagingBenchmark.peakStagingBytes,
    },
    phaseMs,
    writeDetail,
    memoryMB: { heapUsed: Math.round(memory.heapUsed / 1048576), rss: Math.round(memory.rss / 1048576) },
  };
  log(`[hreflang-index-manifest] ${JSON.stringify(summary)}`);
  for (const [locale, source] of Object.entries(manifestSources)) {
    if (source === 'missing' || source.startsWith('invalid')) {
      log(`::warning title=hreflang manifest ${locale} assente::Manifest ${locale} ${source}: le alternate verso /${locale === 'it' ? '' : `${locale}/`} non sono verificate in questa gamba (comportamento precedente).`);
    }
  }
  return summary;
}

function parseArgs(argv) {
  const args = { distDir: 'dist', manifestDir: '.cache/hreflang-index-manifest', dryRun: false, manifestOnly: false, requireForeignManifests: false, baseUrl: DEFAULT_BASE_URL, concurrency: 64 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--manifest-only') args.manifestOnly = true;
    else if (a === '--require-foreign-manifests') args.requireForeignManifests = true;
    else if (a === '--manifest-dir') args.manifestDir = argv[++i];
    else if (a === '--prepass-cache') args.prepassCachePath = argv[++i];
    else if (a === '--reuse-prepass-cache') args.reusePrepassCachePath = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || 64;
    else if (a === '--write-workers') args.writeWorkers = normaliseWriteWorkers(argv[++i]);
    else rest.push(a);
  }
  if (rest[0]) args.distDir = rest[0];
  return args;
}

const invokedDirectly = isMainThread && (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(args.distDir);
  if (!fs.existsSync(distDir)) {
    console.error(`[hreflang-index-manifest] ${distDir} does not exist`);
    process.exit(1);
  }
  runHreflangIndexManifest({
    distDir,
    manifestDir: path.resolve(args.manifestDir),
    ownedLocales: ownedLocalesFromEnv(),
    baseUrl: args.baseUrl,
    dryRun: args.dryRun,
    manifestOnly: args.manifestOnly,
    requireForeignManifests: args.requireForeignManifests,
    prepassCachePath: args.prepassCachePath ? path.resolve(args.prepassCachePath) : null,
    reusePrepassCachePath: args.reusePrepassCachePath ? path.resolve(args.reusePrepassCachePath) : null,
    concurrency: args.concurrency,
    writeWorkers: args.writeWorkers,
  }).catch((error) => {
    console.error(`[hreflang-index-manifest] failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}

if (!isMainThread && workerData?.role === WRITE_WORKER_ROLE) serveRewriteWorker(workerData);
