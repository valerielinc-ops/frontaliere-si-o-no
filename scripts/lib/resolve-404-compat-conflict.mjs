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
 * After merging the conflicted shard(s) the store is re-normalised
 * (`writeCompatPaths(readCompatPaths())`) so the manifest's `totalPaths` and
 * `lastUpdated` are refreshed and every shard is in canonical form (unchanged
 * shards stay byte-identical → no spurious diff), then
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
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './compat-paths-floor-guard.mjs';
import { gitShowStage } from './git-show-stage.mjs';
import {
  readCompatPaths,
  writeCompatPaths,
  COMPAT_SHARD_DIR,
  COMPAT_LEGACY_FILE,
  compatManifestFile,
} from './compat-paths-store.mjs';

const STATE_FILE = 'data/inspection-state.json';
const SHARD_FILE_RE = new RegExp(`^${COMPAT_SHARD_DIR}/part-\\d+\\.json$`);
const MANIFEST_FILE = `${COMPAT_SHARD_DIR}/manifest.json`;

function readStage(stage, file) {
  // During `git rebase`, stage 1 = base, stage 2 = "ours" (the rebase base,
  // i.e. upstream we replay onto), stage 3 = "theirs" (our local commit
  // being applied). See scripts/lib/resolve-winners-conflict.mjs for the
  // same inverted-meaning explanation.
  try {
    return gitShowStage(stage, file);
  } catch {
    return null;
  }
}

function parseCompat(label, raw) {
  if (raw == null) return { paths: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!Array.isArray(parsed.paths)) parsed.paths = [];
      return parsed;
    }
    process.stderr.write(`[resolve-404-compat] ${label} not a JSON object; treating as empty\n`);
    return { paths: [] };
  } catch (err) {
    process.stderr.write(`[resolve-404-compat] ${label} JSON parse failed: ${err.message}\n`);
    return { paths: [] };
  }
}

/** 3-way set merge a single compat file (shard or legacy monolith); write the
 *  resolved JSON back. Returns { prev, next } path counts for the floor guard. */
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

  fs.writeFileSync(
    path.resolve(process.cwd(), file),
    JSON.stringify({ paths: [...finalSet].sort() }, null, 2) + '\n',
    'utf-8',
  );
  return { prev: Math.max(baseSet.size, upstreamSet.size, localSet.size), next: finalSet.size };
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

const shardConflicts = conflicted.filter((f) => SHARD_FILE_RE.test(f));
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

// 1) Merge each conflicted data file so it parses cleanly again.
let prevTotal = 0;
let mergedTotal = 0;
for (const file of [...shardConflicts, ...(legacyConflict ? [COMPAT_LEGACY_FILE] : [])]) {
  const { prev, next } = mergeCompatFile(file);
  prevTotal += prev;
  mergedTotal += next;
  process.stdout.write(`[resolve-404-compat] ${file}: ${prev} → ${next}\n`);
}
// Non-conflicted shards keep their already-correct on-disk content; their
// counts are identical on both sides, so they don't affect the floor delta.

// 2) Resolve a conflicted manifest by taking the local (freshest) metadata —
//    totalPaths/lastUpdated are recomputed in step 3, so only source matters.
if (manifestConflict) {
  const localMeta = parseCompat('local:manifest', readStage(3, MANIFEST_FILE));
  const { paths: _p, totalPaths: _t, shardCount: _s, ...meta } = localMeta;
  fs.writeFileSync(compatManifestFile(), JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

// 3) Re-normalise the whole store (canonical shards + fresh manifest) and fold
//    in a still-present legacy monolith (migration transition only). This keeps
//    the manifest's totalPaths accurate; unchanged shards stay byte-identical.
const union = new Set(readCompatPaths().paths);
try {
  const legacy = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), COMPAT_LEGACY_FILE), 'utf-8'));
  if (Array.isArray(legacy?.paths)) for (const p of legacy.paths) if (typeof p === 'string') union.add(p);
} catch {
  /* no legacy monolith — normal post-migration state */
}
const store = readCompatPaths();
writeCompatPaths({ ...store, paths: [...union] });

// Floor-guard (#1353): a parse failure on any input degrades it to `{paths:[]}`
// (see parseCompat), so the set merge could collapse the accumulator. With
// sharding a single bad shard only loses ~1/shardCount, well above the floor;
// this catches a broad collapse. Compare the post-merge total against the floor
// while the prior version was large.
const finalTotal = readCompatPaths().paths.length;
assertCompatFloor(Math.max(prevTotal, finalTotal, COMPAT_PATHS_SANITY_FLOOR), finalTotal);

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
