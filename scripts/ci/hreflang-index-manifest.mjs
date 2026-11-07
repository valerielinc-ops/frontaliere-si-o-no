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
 *     has been made. Writes use bounded batches and a failed write rolls back
 *     its current batch. Earlier batches can be rewritten locally, but a
 *     failed workflow step cannot upload that partial `dist/`.
 *   - One summary line `[hreflang-index-manifest] {...}` with every counter.
 *
 * Usage:
 *   node scripts/ci/hreflang-index-manifest.mjs [distDir]
 *     [--manifest-dir .cache/hreflang-index-manifest] [--dry-run]
 *     [--manifest-only]
 *     [--prepass-cache <path> | --reuse-prepass-cache <path>]
 *     [--require-foreign-manifests]
 *     [--base-url https://frontaliereticino.ch] [--concurrency 64]
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
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
const HREFLANG_PREPASS_CACHE_VERSION = 1;

export function ownedLocalesFromEnv(raw = process.env.BUILD_LOCALE) {
  const wanted = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((l) => MANIFEST_LOCALES.includes(l));
  return wanted.length > 0 ? [...new Set(wanted)] : MANIFEST_LOCALES.slice();
}

function* walkHtml(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read HTML directory ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
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
    withHreflang.push({ file, urlPath: record.urlPath });
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
 */
export function benchmarkHreflangStaging(records, batchSize = HREFLANG_REWRITE_BATCH_SIZE) {
  const size = normaliseRewriteBatchSize(batchSize);
  const preBatchPeakBytes = records.reduce(
    (total, record) => total + record.originalBytes + record.stagedBytes,
    0,
  );
  let peakStagingBytes = 0;
  for (let offset = 0; offset < records.length; offset += size) {
    const batch = records.slice(offset, offset + size);
    const batchBytes = batch.reduce(
      (total, record) => total + record.originalBytes + record.stagedBytes,
      0,
    );
    peakStagingBytes = Math.max(peakStagingBytes, batchBytes);
  }
  return {
    phase: 'build-locale:hreflang-index-manifest',
    inputFiles: records.length,
    batchSize: Number.isFinite(size) ? size : 'unbounded',
    preBatchPeakBytes,
    peakStagingBytes,
    reductionBytes: preBatchPeakBytes - peakStagingBytes,
  };
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
  const readFailures = [];

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
  }

  if (prepassCache !== 'reused') {
    files = [];
    for (const file of walkHtml(distDir)) {
      const urlPath = distFileToUrlPath(file, distDir);
      if (urlPath === null) continue;
      if (!owned.has(localeOfPath(urlPath))) continue;
      files.push({ file, urlPath });
    }

    // `foo/index.html` and a flat `foo.html` serve the same normalised path;
    // the directory index is the document the canonical URL (trailing slash)
    // resolves to, so it is the one recorded in the manifest. Decided here,
    // synchronously, so the result never depends on read completion order.
    const isIndex = (file) => path.basename(file) === 'index.html';
    const primaryByPath = new Map();
    for (const item of files) {
      const seen = primaryByPath.get(item.urlPath);
      if (seen === undefined || (!isIndex(seen.file) && isIndex(item.file))) primaryByPath.set(item.urlPath, item);
    }

    // ── Pass 1: classify every owned page from its head ───────────────────
    // Only what the decision needs survives the pass: the manifest entry of
    // an eligible page and the PATH of a page carrying hreflang.
    await mapPool(files, concurrency, async (item) => {
      const head = await readHeadOrAll(item.file);
      if (head === null) {
        readFailures.push(item.file);
        return;
      }
      const page = classifyHreflangPage(head, item.urlPath, { baseUrl });
      bump(pagesByReason, page.reason);
      if (page.eligible && primaryByPath.get(item.urlPath) === item) {
        current.get(localeOfPath(page.path)).set(item.urlPath, page.clusterKey);
      }
      if (page.hasHreflang) withHreflang.push(item);
    });
    if (readFailures.length > 0) {
      throw new Error(`${readFailures.length} HTML file(s) unreadable, first: ${readFailures[0]}`);
    }
    pagesScanned = files.length;
  }

  // ── Manifests of the locales this leg does not own ───────────────────────
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

  // ── Pass 2: decide every block before touching any file ─────────────────
  const blocksByDecision = {};
  const unknownMembers = {};
  const changes = [];
  if (!manifestOnly) {
    await mapPool(withHreflang, concurrency, async (item) => {
      const head = await readHeadOrAll(item.file);
      if (head === null) {
        readFailures.push(item.file);
        return;
      }
      const page = classifyHreflangPage(head, item.urlPath, { baseUrl });
      const decision = decideHreflangBlock(page, lookup);
      bump(blocksByDecision, `${decision.action}:${decision.reason}`);
      for (const reason of decision.unknown) bump(unknownMembers, reason);
      if (decision.action === 'strip' || decision.xDefault !== null) {
        changes.push({ file: item.file, decision: { action: decision.action, reason: decision.reason, xDefault: decision.xDefault } });
      }
    });
    if (readFailures.length > 0) {
      throw new Error(`${readFailures.length} HTML file(s) unreadable in pass 2, first: ${readFailures[0]}`);
    }
  }

  // ── Pass 3: write ──────────────────────────────────────────────────────
  let filesRewritten = 0;
  const stagingRecords = [];
  if (!dryRun) {
    // Keep at most one bounded batch of duplicate HTML on disk. The temp dir
    // lives under `dist/` so staged files and page files share a filesystem;
    // the commit phase keeps backups and can roll back every rename in its
    // current batch. A later batch failure fails this workflow step, so the
    // partially rewritten local dist is never packed or uploaded.
    for (let offset = 0; offset < changes.length; offset += batchSize) {
      const batch = changes.slice(offset, offset + batchSize);
      const transactionDir = await fs.promises.mkdtemp(path.join(distDir, '.hreflang-index-'));
      const staged = [];
      try {
        await mapPool(batch, concurrency, async ({ file, decision }, index) => {
          const html = await fs.promises.readFile(file, 'utf-8');
          const next = applyHreflangDecision(html, decision);
          if (next === null) return;
          const stagedFile = path.join(transactionDir, String(index));
          const originalBytes = (await fs.promises.stat(file)).size;
          await fs.promises.writeFile(stagedFile, next, 'utf-8');
          staged.push({ file, stagedFile, index, originalBytes, stagedBytes: Buffer.byteLength(next, 'utf-8') });
        });

        // mapPool completes writes out of order; restore the production batch
        // order so the same-input benchmark measures the same groups that
        // were actually present on disk together.
        staged.sort((a, b) => a.index - b.index);
        const transactionId = path.basename(transactionDir);
        const moved = [];
        try {
          for (const item of staged) {
            const backup = `${item.file}.${transactionId}.bak`;
            await fs.promises.rename(item.file, backup);
            const record = { ...item, backup, installed: false };
            moved.push(record);
            await fs.promises.rename(item.stagedFile, item.file);
            record.installed = true;
          }
        } catch (error) {
          for (const item of [...moved].reverse()) {
            try {
              if (item.installed) await fs.promises.rm(item.file, { force: true });
              await fs.promises.rename(item.backup, item.file);
            } catch {
              // Preserve the original failure; the workflow remains fail-closed.
            }
          }
          throw error;
        }
        for (const item of moved) await fs.promises.rm(item.backup, { force: true });
        stagingRecords.push(...staged);
        filesRewritten += moved.length;
      } finally {
        await fs.promises.rm(transactionDir, { recursive: true, force: true });
      }
    }
  }

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

  const stagingBenchmark = dryRun ? null : benchmarkHreflangStaging(stagingRecords, batchSize);
  const summary = {
    owned: [...owned],
    dryRun,
    manifestOnly,
    pagesScanned,
    pagesByReason,
    pagesWithHreflang: withHreflang.length,
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
    else rest.push(a);
  }
  if (rest[0]) args.distDir = rest[0];
  return args;
}

const invokedDirectly = (() => {
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
  }).catch((error) => {
    console.error(`[hreflang-index-manifest] failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}
