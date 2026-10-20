#!/usr/bin/env node
// Run only in the publisher's isolated worktree. An explicit merge base lets
// shallow runners merge the two trees without downloading the entire history.
// Set EVENTS_DERIVED_DATASET_RECONCILIATION=events when publishing the event
// source slices/cache and their derived dataset outputs together. The original
// workflow checkout is used through RECONCILE_SOURCE_ROOT or GITHUB_WORKSPACE
// to run the real assembler without expanding this isolated worktree.
// Pass --compat when publishing the sharded 404 compatibility store; its
// accumulator and manifest have dedicated semantic reconciliation below.
// Set EVENTS_REFRESH_CARRIED_REF to the pending refresh the crawl restored its
// source slices and checkpoints from: a conflict on one of those files whose
// main version is that very state is a continuation, not a concurrent edit.
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
import { readGitBlobIfPresent } from '../lib/read-git-blob.mjs';
import { EVENT_CACHE_PATHS, mergeRefreshContent } from './open-data-refresh-merge.mjs';

const EVENT_DERIVED_DATASET_RECONCILIATION = 'events';
const EVENT_DERIVED_DATASET_PATHS = [
  'data/events.json',
  'public/data/events.json',
];
const EVENT_SOURCE_SLICE_ROOT = 'data/events/by-source';
const EVENT_SOURCE_CHECKPOINT_ROOT = 'data/events/checkpoints';
const EVENT_REWRITE_CACHE_PATH = 'data/events-description-rewrites.json';
const EVENT_IMAGE_LIBRARY_PATH = 'data/event-image-library.json';
const COMPAT_MANIFEST_PATH = 'data/seo-404-compat/manifest.json';
const COMPAT_SHARD_ROOT = 'data/seo-404-compat';
const COMPAT_SHARD_RE = /^data\/seo-404-compat\/part-\d+\.json$/u;
const CF_HOT_404_PATH = 'data/cf-hot-404s.json';
const GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;

const options = { compat: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i];
  if (flag === '--compat') {
    options.compat = true;
    continue;
  }
  if (!['--base', '--main', '--message'].includes(flag) || !process.argv[i + 1]) {
    throw new Error('Usage: reconcile-data-refresh-main.mjs [--compat] --base SHA --main SHA --message TEXT');
  }
  options[flag.slice(2)] = process.argv[i + 1];
  i += 1;
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
  return readGitBlobIfPresent(ref, file, options);
}

function treeFiles(tree, prefix) {
  const raw = git(['ls-tree', '-r', '--name-only', '-z', tree, '--', prefix]);
  return raw ? raw.split('\0').filter(Boolean) : [];
}

function compatPathsInTree(tree) {
  const paths = new Set(
    treeFiles(tree, COMPAT_SHARD_ROOT).filter((file) => (
      file === COMPAT_MANIFEST_PATH || COMPAT_SHARD_RE.test(file)
    )),
  );
  if (readBlob(tree, CF_HOT_404_PATH, { encoding: null }) !== null) paths.add(CF_HOT_404_PATH);
  return paths;
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

function configuredCompatPaths() {
  return options.compat ? new Set([CF_HOT_404_PATH, COMPAT_MANIFEST_PATH]) : new Set();
}

function parseCompatManifest(raw, label) {
  if (raw === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

function compatManifestFreshness(manifest) {
  for (const key of ['lastUpdated', 'generatedAt', 'updatedAt']) {
    if (typeof manifest[key] === 'string' && manifest[key]) return manifest[key];
  }
  return '';
}

function mergedCompatPathCount(tree) {
  const paths = new Set();
  for (const file of treeFiles(tree, COMPAT_SHARD_ROOT).filter((candidate) => COMPAT_SHARD_RE.test(candidate))) {
    const raw = readBlob(tree, file, { encoding: null });
    if (raw === null) throw new Error(`Cannot read merged compatibility shard ${file}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Merged compatibility shard ${file} is not valid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.paths)) {
      throw new Error(`Merged compatibility shard ${file} must contain a paths array`);
    }
    for (const value of parsed.paths) {
      if (typeof value !== 'string') throw new Error(`Merged compatibility shard ${file} contains a non-string path`);
      paths.add(value);
    }
  }
  return paths.size;
}

function mergeCompatManifest(tree, baseRaw, mainRaw, headRaw) {
  // Resolve deletions against the merge base before dropping missing blobs.
  // When one branch deletes the manifest and the other is unchanged, the
  // deletion is the only change and must survive the reconciliation instead
  // of being replaced by the unchanged base/current-refresh copy.
  if (mainRaw === null && headRaw === null) return null;
  const mainChanged = mainRaw !== baseRaw;
  const headChanged = headRaw !== baseRaw;
  if ((mainRaw === null && !headChanged) || (headRaw === null && !mainChanged)) return null;

  // `head` is the current refresh and wins ties; main wins only when it has a
  // strictly newer freshness marker. Counts are always recomputed from the
  // merged shards, never copied from either stale manifest.
  const candidates = [
    ['merge base', baseRaw],
    ['main', mainRaw],
    ['current refresh', headRaw],
  ].filter(([, raw]) => raw !== null)
    .map(([label, raw]) => ({ label, manifest: parseCompatManifest(raw, `Compatibility manifest ${label}`) }));
  if (candidates.length === 0) return null;
  let winner = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (compatManifestFreshness(candidate.manifest) >= compatManifestFreshness(winner.manifest)) {
      winner = candidate;
    }
  }
  const { paths: _paths, totalPaths: _totalPaths, shardCount: _shardCount, ...metadata } = winner.manifest;
  const shardFiles = treeFiles(tree, COMPAT_SHARD_ROOT).filter((candidate) => COMPAT_SHARD_RE.test(candidate));
  return `${JSON.stringify({
    ...metadata,
    shardCount: shardFiles.length,
    totalPaths: mergedCompatPathCount(tree),
  }, null, 2)}\n`;
}

function isEventSourceState(file) {
  return file.endsWith('.json')
    && [EVENT_SOURCE_SLICE_ROOT, EVENT_SOURCE_CHECKPOINT_ROOT].includes(path.posix.dirname(file));
}

// The crawl restores the slices and checkpoints of the pending refresh before
// it runs, and writes its own on top of them. When that pending refresh is
// merged while the crawl is still running, main and this branch have both
// changed the same files since the merge base, and a three-way merge calls it
// a conflict. It is a chain: this branch holds the state main now has, plus
// one crawl. That is only known when main's bytes are the bytes the crawl
// started from. Anything else on main (a later crawl, the licence audit, which
// also writes the slices) stays a conflict, and the publisher stops.
function carriedRefreshRef() {
  const ref = (process.env.EVENTS_REFRESH_CARRIED_REF || '').trim();
  if (!ref) return null;
  const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (resolved.status !== 0) {
    throw new Error(`EVENTS_REFRESH_CARRIED_REF names ${ref}, which is not a commit in this checkout`);
  }
  return resolved.stdout.trim();
}

function continuesCarriedState(file, { carried, head, main }) {
  if (!carried || !isEventSourceState(file)) return false;
  const started = readBlob(carried, file, { encoding: null });
  const onMain = readBlob(main, file, { encoding: null });
  // A file this branch no longer has is not a state to carry on: it stops too.
  return started !== null && onMain !== null && Buffer.compare(started, onMain) === 0
    && readBlob(head, file, { encoding: null }) !== null;
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

async function regenerateEventDataset({ tree, head, base, main, cacheOverrides, continuedSourceState }) {
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
      // The merged tree holds conflict markers for a continued slice: the
      // assembler reads this branch's version, the one the index now carries.
      const content = readBlob(continuedSourceState.has(file) ? head : tree, file, { encoding: null });
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
const compatPaths = configuredCompatPaths();
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
const carried = carriedRefreshRef();
const continuedSourceState = new Set(
  conflicts.filter((file) => continuesCarriedState(file, { carried, head, main: options.main })),
);
const blockers = conflicts.filter((file) =>
  !EVENT_CACHE_PATHS.has(file)
    && !derivedDatasetPaths.has(file)
    && !compatPaths.has(file)
    && !continuedSourceState.has(file));
if (blockers.length > 0) {
  // Only what stops the reconciliation is named. A caller that did not opt in
  // keeps the wording its logs and tests already know.
  const resolvableParts = ['event caches'];
  if (derivedDatasetPaths.size > 0) resolvableParts.push('derived datasets');
  if (compatPaths.size > 0) resolvableParts.push('compatibility data');
  const resolvable = resolvableParts.join(', ').replace(/, ([^,]+)$/u, ' or $1');
  const sourceState = blockers.filter(isEventSourceState);
  const why = sourceState.length === 0
    ? ''
    : carried
      ? `\nNot a continuation of the refresh this crawl started from (main holds something else, or this branch dropped the file): ${sourceState.join(', ')}`
      : `\nNo starting refresh was recorded (EVENTS_REFRESH_CARRIED_REF), so a continuation cannot be told from a concurrent edit: ${sourceState.join(', ')}`;
  throw new Error(`Unresolved refresh conflict outside ${resolvable}: ${blockers.join(', ')}${why}`);
}

git(['read-tree', tree]);
for (const file of continuedSourceState) {
  git(['update-index', '--add', '--cacheinfo', `100644,${git(['rev-parse', `${head}:${file}`])},${file}`]);
}
const cacheOverrides = new Map();
for (const file of conflicts) {
  if (!EVENT_CACHE_PATHS.has(file)) continue;
  const content = mergeRefreshContent(file, blob(options.base, file), blob(options.main, file), blob(head, file));
  if (content === null) throw new Error(`Cannot resolve missing cache ${file}`);
  cacheOverrides.set(file, content);
  writeIndexBlob(file, content);
}

const compatOverrides = new Map();
const compatWorktreePaths = new Set();
const compatWorktreeDeletions = new Set();
const applyCompatContent = (file, content) => {
  const treeContent = blob(tree, file);
  if (content === null) {
    if (treeContent !== null) compatOverrides.set(file, null);
    compatWorktreeDeletions.add(file);
    git(['update-index', '--force-remove', '--', file]);
    return;
  }
  if (treeContent !== content) compatOverrides.set(file, content);
  compatWorktreePaths.add(file);
  writeIndexBlob(file, content);
};
if (options.compat) {
  // Git can merge the pretty-printed accumulator cleanly while still choosing
  // one side's complete snapshot. Always apply the semantic 3-way merge so a
  // clean textual merge cannot discard a path added by the other refresh.
  applyCompatContent(
    CF_HOT_404_PATH,
    mergeRefreshContent(
      CF_HOT_404_PATH,
      blob(options.base, CF_HOT_404_PATH),
      blob(options.main, CF_HOT_404_PATH),
      blob(head, CF_HOT_404_PATH),
    ),
  );

  // Even when Git sees identical manifest bytes, a compat shard driver may
  // have combined two different sets whose cardinality changes. Recompute the
  // manifest from the merged tree every time so totalPaths cannot go stale.
  const manifest = mergeCompatManifest(
    tree,
    blob(options.base, COMPAT_MANIFEST_PATH),
    blob(options.main, COMPAT_MANIFEST_PATH),
    blob(head, COMPAT_MANIFEST_PATH),
  );
  applyCompatContent(COMPAT_MANIFEST_PATH, manifest);

  // `read-tree` seeds the index without touching the worktree, and the
  // plumbing commit below updates HEAD without checking it out. Keep the
  // compatibility files on disk aligned with the committed tree as well;
  // callers read these generated files immediately after reconciliation.
  for (const file of treeFiles(tree, COMPAT_SHARD_ROOT).filter((candidate) => COMPAT_SHARD_RE.test(candidate))) {
    compatWorktreePaths.add(file);
  }
  for (const file of compatPathsInTree(head)) {
    if (!compatWorktreePaths.has(file)) compatWorktreeDeletions.add(file);
  }
  if (compatWorktreePaths.size > 0) {
    git(['checkout-index', '--force', '--ignore-skip-worktree-bits', '--', ...[...compatWorktreePaths].sort()]);
  }
  for (const file of [...compatWorktreeDeletions].sort()) rmSync(file, { force: true });
}

const derivedConflicts = conflicts.filter((file) => derivedDatasetPaths.has(file));
if (derivedConflicts.length > 0 && derivedDatasetPaths.has('data/events.json')) {
  await regenerateEventDataset({
    tree,
    head,
    base: options.base,
    main: options.main,
    cacheOverrides,
    continuedSourceState,
  });
}
// `--missing-ok`: the index is the merged tree plus the blobs hashed above. The
// refresh checkout holds branch tips only, and after a filtered fetch a plain
// `write-tree` would download every blob of that tree it does not have.
const mergedTree = git(['write-tree', '--missing-ok']);
const commit = git(['commit-tree', mergedTree, '-p', head, '-p', options.main, '-m', options.message]);
git(['update-ref', 'HEAD', commit, head]);
process.stdout.write(
  `[reconcile-data-refresh-main] merged main; resolved ${conflicts.filter((file) => EVENT_CACHE_PATHS.has(file)).length} cache conflict(s)`
    + (continuedSourceState.size > 0
      ? `; continued ${continuedSourceState.size} source state file(s) from the carried refresh`
      : '')
    + (compatOverrides.size > 0 ? `; resolved ${compatOverrides.size} compatibility conflict(s)` : '')
    + (derivedConflicts.length > 0 ? `; regenerated ${EVENT_DERIVED_DATASET_PATHS.join(', ')}` : '')
    + '\n',
);
