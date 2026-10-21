#!/usr/bin/env node
/**
 * In-place rebase resolver for the sharded `data/seo-404-compat/` accumulator
 * (issue #2988 split the old single `data/seo-404-compat-paths.json` monolith
 * into `part-NN.json` shards once it crossed GitHub's hard 100 MB push limit).
 *
 * Why this exists: discover-404s.yml is not the only workflow that writes the
 * accumulator. sync-gsc-orphans.yml (and a few scripts: backfill-slug-aliases,
 * mine-all-job-slugs, enrich-compat-orphan-slugs) also append/remove paths.
 * When two workflows push back-to-back the rebase inside
 * `scripts/lib/git-push-with-retry.sh` hits a content conflict on the shard
 * file(s). Git has no built-in way to merge a JSON array, so the helper
 * aborted with "no resolver provided".
 *
 * Resolution semantics: per-shard 3-way set merge on `paths`.
 *
 *   final = upstream ∪ (local − base) − (base − local)
 *
 *   - paths the local commit ADDED (in local but not in base) are added on
 *     top of upstream → preserves our newly-discovered 404s.
 *   - paths the local commit REMOVED (in base but not in local) are removed
 *     from upstream → preserves our "URL recovered, drop from compat".
 *   - paths upstream added since base are kept → preserves sync-gsc-orphans'
 *     additions that we did not see when we read the file.
 *
 * The per-shard merge is correct because path→shard assignment is DETERMINISTIC
 * (compat-paths-store.mjs): a path's base/upstream/local versions all live in
 * the same shard, so merging each conflicted shard independently and leaving
 * the cleanly-merged shards untouched reconstructs the exact full union.
 *
 * After merging the conflicted shard(s) a complete candidate is assembled in
 * memory, guarded, and re-normalised with `writeCompatPaths()` so the
 * manifest's `totalPaths` and `lastUpdated` are refreshed and every shard is
 * in canonical form (unchanged shards stay byte-identical → no spurious diff), then
 * `scripts/prune-404-compat-paths.ts` is re-run so the resolvability gate also
 * covers paths reintroduced by the set-union with `upstream` — otherwise a
 * non-resolving upstream path could survive the merge and turn main red.
 *
 * `data/inspection-state.json` is exclusively owned by
 * discover-404s-via-inspection.mjs — if it ever shows up as conflicted,
 * surface the fact instead of merging silently.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertCompatFloor,
  assertCompatPruneFamilySafety,
  assertCompatPruneSafety,
  compatPathFamily,
  COMPAT_PATHS_SANITY_FLOOR,
} from './compat-paths-floor-guard.mjs';
import { gitShowStage } from './git-show-stage.mjs';
import {
  readCompatPathsStrict,
  readCompatPathsStrictAfterMerge,
  writeCompatPaths,
  compatShardIndex,
  COMPAT_SHARD_DIR,
  COMPAT_SHARD_COUNT,
  COMPAT_LEGACY_FILE,
  compatManifestFile,
} from './compat-paths-store.mjs';
import { shardFileName, SHARD_FILE_RE } from './shard-file-naming.mjs';

const STATE_FILE = 'data/inspection-state.json';
const MANIFEST_FILE = `${COMPAT_SHARD_DIR}/manifest.json`;

function readStage(stage, file) {
  // During `git rebase`, stage 1 = base, stage 2 = "ours" (the rebase base,
  // i.e. upstream we replay onto), stage 3 = "theirs" (our local commit
  // being applied). See scripts/lib/resolve-winners-conflict.mjs for the
  // same inverted-meaning explanation.
  try {
    return gitShowStage(stage, file);
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    const missingStage = err?.status === 128 && (
      /path .* does not exist/i.test(stderr)
      || /path .* exists on disk, but not in/i.test(stderr)
      || /path .* is in the index, but not at stage \d+/i.test(stderr)
    );
    if (missingStage) return null;
    throw new Error(
      `[resolve-404-compat] cannot read git stage ${stage}:${file}: ${stderr.trim() || err?.message || err}`,
      { cause: err },
    );
  }
}

function parseCompat(label, raw, { requirePaths = true } = {}) {
  if (raw == null) return { paths: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    if (requirePaths && !Array.isArray(parsed.paths)) {
      throw new Error('missing paths array');
    }
    if (Array.isArray(parsed.paths) && parsed.paths.some((p) => typeof p !== 'string')) {
      throw new Error('paths must contain only strings');
    }
    return parsed;
  } catch (err) {
    throw new Error(`[resolve-404-compat] ${label} is invalid: ${err.message}`, { cause: err });
  }
}

function manifestTotal(label, raw) {
  if (raw == null) return null;
  const meta = parseCompat(label, raw, { requirePaths: false });
  if (meta.shardCount !== COMPAT_SHARD_COUNT
    || !Number.isSafeInteger(meta.totalPaths) || meta.totalPaths < 0) {
    throw new Error(
      `[resolve-404-compat] ${label} is not a valid compatibility manifest `
      + `(shardCount=${meta.shardCount}, totalPaths=${meta.totalPaths})`,
    );
  }
  return meta.totalPaths;
}

function previousStoreTotal() {
  const stageTotals = [1, 2, 3]
    .map((stage) => manifestTotal(`manifest stage ${stage}`, readStage(stage, MANIFEST_FILE)))
    .filter((value) => value !== null);
  if (stageTotals.length > 0) return Math.max(...stageTotals);

  try {
    return manifestTotal('working-tree manifest', fs.readFileSync(compatManifestFile(), 'utf-8')) ?? 0;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

/** 3-way set merge a single compat file (shard or legacy monolith) without
 * touching the working tree. Returns the candidate paths and counts used by
 * the pre-write safety guards. */
function mergeCompatFile(file) {
  const base = parseCompat(`base:${file}`, readStage(1, file));
  const upstream = parseCompat(`upstream:${file}`, readStage(2, file));
  const local = parseCompat(`local:${file}`, readStage(3, file));

  const baseSet = new Set(base.paths);
  const upstreamSet = new Set(upstream.paths);
  const localSet = new Set(local.paths);

  const finalSet = new Set(upstreamSet);
  for (const p of localSet) if (!baseSet.has(p)) finalSet.add(p); // local additions
  for (const p of baseSet) if (!localSet.has(p)) finalSet.delete(p); // local removals

  return {
    prev: Math.max(baseSet.size, upstreamSet.size, localSet.size),
    next: finalSet.size,
    paths: [...finalSet].sort(),
  };
}

/**
 * Independently derive the number of paths the complete post-merge shard set
 * must contain. Conflicted shards use the preflighted 3-way result; every
 * clean shard is read from index stage 0 and compared byte-for-byte with the
 * working tree. This prevents a valid-but-truncated unrelated shard from
 * being hidden by the resolver's stale-manifest exception.
 */
function expectedMergedShardEntries(mergedFiles, shardConflicts) {
  const mergedByFile = new Map(mergedFiles.map((entry) => [entry.file, entry]));
  const conflictSet = new Set(shardConflicts);
  const shardDir = path.resolve(process.cwd(), COMPAT_SHARD_DIR);

  // A legacy-only migration conflict has no shard set yet; in that case the
  // legacy merge itself is the complete store for this validation pass.
  if (!fs.existsSync(shardDir)) {
    const indexedShard = Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) =>
      readStage(0, `${COMPAT_SHARD_DIR}/${shardFileName(i)}`),
    ).some((raw) => raw !== null);
    if (shardConflicts.length > 0 || indexedShard) {
      throw new Error(
        `[resolve-404-compat] shard directory ${COMPAT_SHARD_DIR} is missing `
        + 'despite indexed compatibility shards; refusing a sparse/incomplete merge',
      );
    }
    return [];
  }

  const entries = [];
  for (let i = 0; i < COMPAT_SHARD_COUNT; i++) {
    const file = `${COMPAT_SHARD_DIR}/${shardFileName(i)}`;
    const merged = mergedByFile.get(file);
    if (merged) {
      entries.push({ file, paths: merged.paths });
      continue;
    }
    if (conflictSet.has(file)) {
      throw new Error(`[resolve-404-compat] missing preflight result for conflicted shard ${file}`);
    }

    const indexedRaw = readStage(0, file);
    const diskFile = path.resolve(process.cwd(), file);
    if (indexedRaw == null) {
      throw new Error(
        `[resolve-404-compat] clean shard ${file} has no stage-0 index entry; `
        + 'refusing to trust an incomplete shard set',
      );
    }
    if (!fs.existsSync(diskFile)) {
      throw new Error(`[resolve-404-compat] clean shard ${file} is missing from the working tree`);
    }
    const diskRaw = fs.readFileSync(diskFile, 'utf-8');
    if (diskRaw !== indexedRaw) {
      throw new Error(
        `[resolve-404-compat] clean shard ${file} differs from its merged index entry; `
        + 'refusing to trust an unindexed/truncated shard',
      );
    }
    entries.push({ file, paths: parseCompat(`index:0:${file}`, indexedRaw).paths });
  }
  return entries;
}

function validateShardEntries(entries) {
  const seen = new Set();
  const paths = [];
  for (const { file, paths: shardPaths } of entries) {
    const shardName = path.posix.basename(file);
    const shardIndex = Number(shardName.slice('part-'.length, -'.json'.length));
    if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= COMPAT_SHARD_COUNT) {
      throw new Error(`[resolve-404-compat] invalid shard name ${file}`);
    }
    for (const p of shardPaths) {
      if (typeof p !== 'string') {
        throw new Error(`[resolve-404-compat] ${file} contains a non-string path`);
      }
      if (seen.has(p)) {
        throw new Error(`[resolve-404-compat] duplicate path ${p} across merged shards`);
      }
      if (compatShardIndex(p) !== shardIndex) {
        throw new Error(
          `[resolve-404-compat] ${file} contains path assigned to shard ${compatShardIndex(p)}: ${p}`,
        );
      }
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

function readLegacyCandidate(mergedFiles) {
  const merged = mergedFiles.find((entry) => entry.file === COMPAT_LEGACY_FILE);
  if (merged) {
    const local = readStage(3, COMPAT_LEGACY_FILE);
    const upstream = local == null ? readStage(2, COMPAT_LEGACY_FILE) : local;
    const parsed = parseCompat('legacy metadata stage', upstream, { requirePaths: false });
    const { paths: _paths, shardCount: _shardCount, totalPaths: _totalPaths, ...meta } = parsed;
    return { paths: merged.paths, meta };
  }
  const legacyFile = path.resolve(process.cwd(), COMPAT_LEGACY_FILE);
  if (!fs.existsSync(legacyFile)) return { paths: [], meta: {} };
  const parsed = parseCompat('working legacy accumulator', fs.readFileSync(legacyFile, 'utf-8'));
  const { paths, ...meta } = parsed;
  return { paths, meta };
}

function readManifestMeta(manifestConflict, legacyMeta) {
  const raw = manifestConflict
    ? readStage(3, MANIFEST_FILE)
    : fs.existsSync(compatManifestFile())
      ? fs.readFileSync(compatManifestFile(), 'utf-8')
      : null;
  if (raw == null) {
    if (Object.keys(legacyMeta).length > 0) return legacyMeta;
    throw new Error('[resolve-404-compat] compatibility manifest is missing; refusing destructive rewrite');
  }
  const parsed = parseCompat(manifestConflict ? 'local:manifest' : 'working-tree manifest', raw, {
    requirePaths: false,
  });
  manifestTotal(manifestConflict ? 'local manifest' : 'working-tree manifest', JSON.stringify(parsed));
  const { paths: _paths, shardCount: _shardCount, totalPaths: _totalPaths, ...meta } = parsed;
  return meta;
}

function previousPathsForConflictedFile(file) {
  const preferred = readStage(2, file);
  const preferredPaths = preferred == null ? null : parseCompat(`upstream:${file}`, preferred).paths;
  const base = readStage(1, file);
  const basePaths = base == null ? null : parseCompat(`base:${file}`, base).paths;

  // An empty or partially reduced stage-2 blob can be a real deletion, but it
  // is also the exact shape produced by a partial-read writer. Use the union
  // with the non-empty ancestor as the family baseline so a whole cohort
  // cannot disappear while the global count remains under automatic limits.
  const baseline = new Set();
  if (preferredPaths !== null) for (const p of preferredPaths) baseline.add(p);
  if (basePaths !== null) for (const p of basePaths) baseline.add(p);
  return Array.from(baseline);
}

function familyEvidence(previousPaths, finalPaths) {
  const previous = new Set(previousPaths);
  const final = new Set(finalPaths);
  const familyTotals = new Map();
  const familyRemoved = new Map();
  for (const p of previous) {
    const family = compatPathFamily(p);
    familyTotals.set(family, (familyTotals.get(family) ?? 0) + 1);
    if (!final.has(p)) familyRemoved.set(family, (familyRemoved.get(family) ?? 0) + 1);
  }
  return { familyTotals, familyRemoved };
}

function appendPaths(target, paths) {
  for (const p of paths) target.push(p);
}

const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf-8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (conflicted.includes(STATE_FILE)) {
  process.stderr.write(
    `[resolve-404-compat] unexpected conflict on ${STATE_FILE} — this file is single-writer; aborting\n`,
  );
  process.exit(1);
}

const shardConflicts = conflicted.filter(
  (f) => path.posix.dirname(f) === COMPAT_SHARD_DIR && SHARD_FILE_RE.test(path.posix.basename(f)),
);
const manifestConflict = conflicted.includes(MANIFEST_FILE);
const legacyConflict = conflicted.includes(COMPAT_LEGACY_FILE);

const handled = new Set([...shardConflicts, COMPAT_LEGACY_FILE, MANIFEST_FILE]);
const unexpected = conflicted.filter((f) => !handled.has(f));
if (unexpected.length > 0) {
  process.stderr.write(
    `[resolve-404-compat] unexpected conflicted files alongside the compat store: ${unexpected.join(', ')}\n`,
  );
  process.exit(1);
}

if (shardConflicts.length === 0 && !manifestConflict && !legacyConflict) {
  process.stdout.write('[resolve-404-compat] no conflict on the compat store\n');
  process.exit(0);
}

// 1) Build the complete candidate in memory. No working-tree file is written
// until every input, clean shard, manifest, and prune guard has passed.
const previousTotal = previousStoreTotal();
const mergeFiles = [...shardConflicts, ...(legacyConflict ? [COMPAT_LEGACY_FILE] : [])];
const mergedFiles = mergeFiles.map((file) => ({ file, ...mergeCompatFile(file) }));
const shardEntries = expectedMergedShardEntries(mergedFiles, shardConflicts);
const shardPaths = validateShardEntries(shardEntries);
const legacy = readLegacyCandidate(mergedFiles);
const candidateSet = new Set();
for (const p of shardPaths) candidateSet.add(p);
for (const p of legacy.paths) candidateSet.add(p);
const candidatePaths = Array.from(candidateSet);
const manifestMeta = readManifestMeta(manifestConflict, legacy.meta);

// The resolver's family baseline is the clean candidate for unaffected shards
// plus the upstream (or base, for add/delete stages) content of conflicted
// files. This is the exact cohort that can be removed by the 3-way conflict
// merge; family loss is guarded before the first write below.
const conflictedSet = new Set(shardConflicts);
const previousPaths = [];
for (const entry of shardEntries) {
  appendPaths(
    previousPaths,
    conflictedSet.has(entry.file) ? previousPathsForConflictedFile(entry.file) : entry.paths,
  );
}
if (legacyConflict) appendPaths(previousPaths, previousPathsForConflictedFile(COMPAT_LEGACY_FILE));
else appendPaths(previousPaths, legacy.paths);

const allowLargePrune = process.env.PRUNE_404_ALLOW_LARGE_PRUNE === '1';
const finalTotal = candidatePaths.length;
assertCompatFloor(previousTotal, finalTotal, { floor: COMPAT_PATHS_SANITY_FLOOR });
assertCompatPruneSafety(previousTotal, finalTotal, {
  label: 'seo-404-compat conflict merge',
  allowLargePrune,
});
const { familyTotals, familyRemoved } = familyEvidence(previousPaths, candidatePaths);
assertCompatPruneFamilySafety(familyTotals, familyRemoved, {
  label: 'seo-404-compat conflict merge',
  allowLargePrune,
});

for (const { file, prev, next } of mergedFiles) {
  process.stdout.write(`[resolve-404-compat] ${file}: ${prev} → ${next}\n`);
}

// 2) Persist the already-validated candidate in one canonical rewrite. This
// also refreshes manifest.totalPaths and removes a migrated legacy monolith;
// no candidate safety guard runs after this point; the strict read below is
// only a post-write invariant check.
writeCompatPaths({ ...manifestMeta, paths: candidatePaths });
const finalStore = readCompatPathsStrictAfterMerge(process.cwd(), finalTotal);
if (finalStore.paths.length !== finalTotal) {
  throw new Error(
    `[resolve-404-compat] post-write store contains ${finalStore.paths.length} paths, `
    + `expected ${finalTotal}`,
  );
}

// Re-run the resolvability prune on the merged result before staging. The
// committing workflows (discover-404s, sync-gsc-orphans) prune BEFORE pushing,
// but this 3-way set merge runs AFTER that gate, inside the rebase. The merge
// keeps everything in `upstream`, so a non-resolving path present upstream — a
// rebase `base` predating the prune-gate deploy, or any future ungated writer —
// would survive into the committed file even though local already pruned it,
// turning tests/search-console-compat.test.ts red → main red (the R2-B pattern,
// #1155 / #1166 item 5). Re-validate here so the merged commit is always
// test-clean. Reuses the single resolvability source (the .ts prune via tsx,
// same idiom as the workflows) instead of duplicating resolver wiring.
// PRUNE_404_STRICT=1 = fail-closed: if tsx or the assembled dataset isn't
// available at this in-rebase point, the prune ABORTS (exit 1) rather than
// silently no-op'ing and letting an unvalidated path survive the merge.
try {
  execFileSync('npx', ['tsx', 'scripts/prune-404-compat-paths.ts'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, PRUNE_404_STRICT: '1' },
  });
} catch (err) {
  process.stderr.write(
    `[resolve-404-compat] post-merge prune failed; refusing to stage a possibly-poisoned file: ${
      err?.message ?? err
    }\n`,
  );
  process.exit(1);
}

// Stage the whole store dir; drop the legacy monolith if it lingered.
execFileSync('git', ['add', '--all', COMPAT_SHARD_DIR]);
try {
  if (fs.existsSync(path.resolve(process.cwd(), COMPAT_LEGACY_FILE))) {
    execFileSync('git', ['rm', '-f', '--ignore-unmatch', COMPAT_LEGACY_FILE]);
  } else {
    execFileSync('git', ['add', '--all', COMPAT_LEGACY_FILE]);
  }
} catch {
  /* legacy file never existed — nothing to stage */
}
