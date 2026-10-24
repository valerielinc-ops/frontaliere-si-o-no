#!/usr/bin/env node
/**
 * hreflang-index-manifest — build this shard's hreflang index manifest and
 * keep only reciprocal hreflang clusters of indexable, self-canonical pages.
 *
 * Contract and rationale: scripts/lib/hreflang-index-manifest.mjs.
 *
 * Where it runs: deploy.yml `build-locale`, once per locale leg, after
 * `prune-locale-shard.mjs` (so `dist/` holds exactly what this leg ships) and
 * before anything packs or pushes `dist/`.
 *
 * Inputs
 *   - `dist/`, the final HTML of the locales this leg owns (`BUILD_LOCALE`,
 *     all four when unset): judged against THIS run's manifest, exactly.
 *   - `<manifest-dir>/<locale>.json` for every locale this leg does NOT own:
 *     the newest manifest another leg saved (actions/cache). When one is
 *     missing or invalid, alternates into that locale are not judged — the
 *     behaviour before this step — and the summary says so.
 *
 * Outputs
 *   - `<manifest-dir>/<locale>.json` for every owned locale (saved to the
 *     cache by the workflow for the other legs and the next run).
 *   - Rewritten HTML (unless `--dry-run`), written only after EVERY decision
 *     has been made: a failure while reading leaves `dist/` untouched.
 *   - One summary line `[hreflang-index-manifest] {...}` with every counter.
 *
 * Usage:
 *   node scripts/ci/hreflang-index-manifest.mjs [distDir]
 *     [--manifest-dir .cache/hreflang-index-manifest] [--dry-run]
 *     [--require-foreign-manifests]
 *     [--base-url https://frontaliereticino.ch] [--concurrency 64]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

async function mapPool(items, concurrency, fn) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
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
  requireForeignManifests = false,
  concurrency = 64,
  runId = process.env.GITHUB_RUN_ID || '',
  log = (line) => console.log(line),
}) {
  const owned = new Set(ownedLocales);
  const files = [];
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

  // ── Pass 1: classify every owned page from its head ─────────────────────
  // Only what the decision needs survives the pass: the manifest entry of an
  // eligible page and the PATH of a page carrying hreflang (its head is read
  // again in pass 2 — retaining every parsed block of a ~700k-page shard
  // would cost far more memory than a second head read costs time).
  const current = new Map(MANIFEST_LOCALES.map((l) => [l, new Map()]));
  const pagesByReason = {};
  const withHreflang = [];
  const readFailures = [];
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

  // ── Pass 3: write ──────────────────────────────────────────────────────
  let filesRewritten = 0;
  if (!dryRun) {
    // Stage every rewritten document before touching `dist/`. The commit phase
    // keeps backups so a rename failure can restore every file already moved;
    // a failed step therefore never leaves a half-rewritten hreflang graph.
    const transactionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hreflang-index-'));
    const staged = [];
    try {
      await mapPool(changes, concurrency, async ({ file, decision }, index) => {
        const html = await fs.promises.readFile(file, 'utf-8');
        const next = applyHreflangDecision(html, decision);
        if (next === null) return;
        const stagedFile = path.join(transactionDir, String(index));
        await fs.promises.writeFile(stagedFile, next, 'utf-8');
        staged.push({ file, stagedFile });
      });

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
      filesRewritten = moved.length;
    } finally {
      await fs.promises.rm(transactionDir, { recursive: true, force: true });
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

  const summary = {
    owned: [...owned],
    dryRun,
    pagesScanned: files.length,
    pagesByReason,
    pagesWithHreflang: withHreflang.length,
    blocksByDecision,
    unknownMembers,
    manifestSources,
    manifestCounts,
    filesToRewrite: changes.length,
    filesRewritten,
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
  const args = { distDir: 'dist', manifestDir: '.cache/hreflang-index-manifest', dryRun: false, requireForeignManifests: false, baseUrl: DEFAULT_BASE_URL, concurrency: 64 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--require-foreign-manifests') args.requireForeignManifests = true;
    else if (a === '--manifest-dir') args.manifestDir = argv[++i];
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
    requireForeignManifests: args.requireForeignManifests,
    concurrency: args.concurrency,
  }).catch((error) => {
    console.error(`[hreflang-index-manifest] failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}
