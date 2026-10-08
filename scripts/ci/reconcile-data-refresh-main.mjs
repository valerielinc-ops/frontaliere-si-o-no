#!/usr/bin/env node
// Run only in the publisher's isolated worktree. An explicit merge base lets
// shallow runners merge the two trees without downloading the entire history.
// Set EVENTS_DERIVED_DATASET_RECONCILIATION=events when publishing the event
// source slices/cache and their derived dataset outputs together. The original
// workflow checkout is used through RECONCILE_SOURCE_ROOT or GITHUB_WORKSPACE
// to run the real assembler without expanding this isolated worktree.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGitBlob } from '../lib/read-git-blob.mjs';
import { EVENT_CACHE_PATHS, mergeRefreshContent } from './open-data-refresh-merge.mjs';

const EVENT_DERIVED_DATASET_RECONCILIATION = 'events';
const EVENT_DERIVED_DATASET_PATHS = [
  'data/events.json',
  'public/data/events.json',
];
const EVENT_SOURCE_SLICE_ROOT = 'data/events/by-source';
const EVENT_REWRITE_CACHE_PATH = 'data/events-description-rewrites.json';
const EVENT_IMAGE_LIBRARY_PATH = 'data/event-image-library.json';
const GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;

// Input materialization must stay within the caller's already-fetched checkout;
// never let a promisor repository turn a missing blob into an unbounded fetch.
process.env.GIT_NO_LAZY_FETCH = '1';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--base', '--main', '--message'].includes(flag) || !process.argv[i + 1]) {
    throw new Error('Usage: reconcile-data-refresh-main.mjs --base SHA --main SHA --message TEXT');
  }
  options[flag.slice(2)] = process.argv[i + 1];
}
if (!options.base || !options.main || !options.message) throw new Error('Missing main reconciliation arguments');

function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: GIT_OUTPUT_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'], input,
  }).trim();
}

function blob(ref, file) {
  return readBlob(ref, file);
}

function readBlob(ref, file, options = {}) {
  try {
    return readGitBlob(ref, file, options);
  } catch (error) {
    if (error?.status === 128) {
      const listed = git(['ls-tree', '-r', '--name-only', ref, '--', file])
        .split('\n')
        .filter(Boolean)
        .includes(file);
      if (!listed) return null;
    }
    throw error;
  }
}

function treeFiles(tree, prefix) {
  const raw = git(['ls-tree', '-r', '--name-only', '-z', tree, '--', prefix]);
  return raw ? raw.split('\0').filter(Boolean) : [];
}

function writeIndexBlob(file, content) {
  const oid = git(['hash-object', '-w', '--stdin'], content);
  git(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`]);
}

function configuredDerivedDatasetPaths() {
  const configured = (process.env.EVENTS_DERIVED_DATASET_RECONCILIATION || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.includes(EVENT_DERIVED_DATASET_RECONCILIATION)
    ? new Set(EVENT_DERIVED_DATASET_PATHS)
    : new Set();
}

function assemblerRoot() {
  const candidates = [
    process.env.RECONCILE_SOURCE_ROOT,
    process.env.GITHUB_WORKSPACE,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'scripts', 'assemble-events-dataset.mjs'))) return candidate;
  }
  return null;
}

async function regenerateEventDataset({ tree, head, base, main, cacheOverrides }) {
  const sourceRoot = assemblerRoot();
  if (!sourceRoot) {
    throw new Error(
      'Cannot regenerate the events dataset: the caller must provide a checkout with scripts/assemble-events-dataset.mjs via RECONCILE_SOURCE_ROOT or GITHUB_WORKSPACE',
    );
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'events-derived-reconcile-'));
  const sliceDir = path.join(tempRoot, 'data', 'events', 'by-source');
  const datasetPath = path.join(tempRoot, 'data', 'events.json');
  const rewriteCachePath = path.join(tempRoot, EVENT_REWRITE_CACHE_PATH);
  mkdirSync(sliceDir, { recursive: true });

  try {
    for (const file of treeFiles(tree, EVENT_SOURCE_SLICE_ROOT)) {
      const content = readBlob(tree, file, { encoding: null });
      if (content !== null) {
        const target = path.join(tempRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }

    const rewriteCache = cacheOverrides.get(EVENT_REWRITE_CACHE_PATH)
      ?? readBlob(tree, EVENT_REWRITE_CACHE_PATH, { encoding: null });
    if (rewriteCache !== null) {
      mkdirSync(path.dirname(rewriteCachePath), { recursive: true });
      writeFileSync(rewriteCachePath, rewriteCache);
    }

    // The prior dataset is only used by the assembler for route/history
    // retention. Prefer the stable refresh tree; the event list itself comes
    // exclusively from the merged source slices.
    const priorDataset = readBlob(head, 'data/events.json', { encoding: null })
      ?? readBlob(main, 'data/events.json', { encoding: null })
      ?? readBlob(base, 'data/events.json', { encoding: null });
    mkdirSync(path.dirname(datasetPath), { recursive: true });
    writeFileSync(datasetPath, priorDataset ?? '{"schemaVersion":1,"events":[]}\n');

    const imageLibrary = readBlob(tree, EVENT_IMAGE_LIBRARY_PATH, { encoding: null });
    const previousImageLibraryPath = process.env.EVENT_IMAGE_LIBRARY_PATH;
    if (imageLibrary !== null) {
      const imageLibraryPath = path.join(tempRoot, EVENT_IMAGE_LIBRARY_PATH);
      mkdirSync(path.dirname(imageLibraryPath), { recursive: true });
      writeFileSync(imageLibraryPath, imageLibrary);
      process.env.EVENT_IMAGE_LIBRARY_PATH = imageLibraryPath;
    }

    try {
      const { assemble } = await import(
        pathToFileURL(path.join(sourceRoot, 'scripts', 'assemble-events-dataset.mjs')).href
      );
      assemble({ sliceDir, datasetPath, rewriteCachePath });
    } finally {
      if (previousImageLibraryPath === undefined) delete process.env.EVENT_IMAGE_LIBRARY_PATH;
      else process.env.EVENT_IMAGE_LIBRARY_PATH = previousImageLibraryPath;
    }

    for (const file of EVENT_DERIVED_DATASET_PATHS) {
      const generated = path.join(tempRoot, file);
      if (!existsSync(generated)) throw new Error(`Assembler did not produce ${file}`);
      writeIndexBlob(file, readFileSync(generated));
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const head = git(['rev-parse', 'HEAD']);
const derivedDatasetPaths = configuredDerivedDatasetPaths();
const merge = spawnSync('git', [
  'merge-tree', '--write-tree', '--name-only', '--no-messages',
  `--merge-base=${options.base}`, head, options.main,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (merge.status !== 0 && merge.status !== 1) {
  throw new Error(`Unable to merge main: ${merge.error?.message || merge.stderr}`);
}
const mergeOutput = merge.stdout.trim();
const [tree, ...conflicts] = mergeOutput ? mergeOutput.split('\n') : [];
if (!tree) throw new Error(`Unable to merge main: ${merge.stderr || 'merge-tree returned no tree'}`);
const blockers = conflicts.filter((file) => !EVENT_CACHE_PATHS.has(file) && !derivedDatasetPaths.has(file));
if (blockers.length > 0) {
  throw new Error(`Unresolved refresh conflict outside event caches or derived datasets: ${blockers.join(', ')}`);
}

git(['read-tree', tree]);
const cacheOverrides = new Map();
for (const file of conflicts) {
  if (!EVENT_CACHE_PATHS.has(file)) continue;
  const content = mergeRefreshContent(file, blob(options.base, file), blob(options.main, file), blob(head, file));
  if (content === null) throw new Error(`Cannot resolve missing cache ${file}`);
  cacheOverrides.set(file, content);
  writeIndexBlob(file, content);
}

const derivedConflicts = conflicts.filter((file) => derivedDatasetPaths.has(file));
if (derivedConflicts.length > 0 && derivedDatasetPaths.has('data/events.json')) {
  await regenerateEventDataset({
    tree,
    head,
    base: options.base,
    main: options.main,
    cacheOverrides,
  });
}
// `--missing-ok`: the index is the merged tree plus the blobs hashed above. The
// refresh checkout holds branch tips only, and after a filtered fetch a plain
// `write-tree` would download every blob of that tree it does not have.
const mergedTree = git(['write-tree', '--missing-ok']);
const commit = git(['commit-tree', mergedTree, '-p', head, '-p', options.main, '-m', options.message]);
git(['update-ref', 'HEAD', commit, head]);
process.stdout.write(
  `[reconcile-data-refresh-main] merged main; resolved ${conflicts.length - derivedConflicts.length} cache conflict(s)`
    + (derivedConflicts.length > 0 ? `; regenerated ${EVENT_DERIVED_DATASET_PATHS.join(', ')}` : '')
    + '\n',
);
