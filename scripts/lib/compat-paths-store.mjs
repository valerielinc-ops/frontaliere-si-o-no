/**
 * Sharded store for the `data/seo-404-compat-paths.json` accumulator
 * (the 404→301 redirect / soft-landing engine).
 *
 * Why this exists (2026-06-29, issue #2988): the accumulator is a single
 * committed JSON file that grows monotonically (multiple workflows append
 * orphan/404 paths and push to `main`). It crossed GitHub's HARD 100 MB
 * per-file push limit (1,078,516 paths / 100.14 MB at push time →
 * `remote: error: File data/seo-404-compat-paths.json is 100.14 MB; this
 * exceeds GitHub's file size limit of 100.00 MB` → `pre-receive hook
 * declined`). Every data-refresh job that commits the file is now permanently
 * red and the file can no longer accept a single new path.
 *
 * Fix (lossless): split the one monolith into a fixed set of plain-JSON-text
 * shards under `data/seo-404-compat/part-NN.json`, each well under the limit.
 * No path is dropped — the logical model is still ONE `{ source, lastUpdated,
 * paths }` set, reconstructed by unioning the shards.
 *
 * Design constraints honoured:
 *  - Plain JSON TEXT per shard (no gzip/binary): the in-rebase 3-way set merge
 *    in `resolve-404-compat-conflict.mjs` and git's own text diff must keep
 *    working across concurrent writers.
 *  - DETERMINISTIC path→shard assignment (stable FNV-1a hash % shardCount): a
 *    given path always lands in the same shard, so the per-shard 3-way merge is
 *    correct and only the shard(s) that actually changed diff on each write
 *    (minimal git churn).
 *  - Metadata (source/lastUpdated) lives in a tiny separate `manifest.json`,
 *    NOT in every shard, so an unchanged shard stays byte-identical run to run.
 *
 * Single source of truth (AGENTS.md #6): every compat reader/writer goes
 * through `readCompatPaths` / `writeCompatPaths` here instead of hand-rolling
 * `fs.readFileSync(...).paths` — that drift is exactly what caused the
 * truncation outages this file's floor-guard sibling guards against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fnv1a32Mod } from './fnv1a.mjs';
import { shardFileName, listShardFilesIn, SHARD_FILE_RE } from './shard-file-naming.mjs';
import { writeShardFileIfChanged, writeFileAtomic } from './atomic-shard-write.mjs';
import { filterCompatPaths } from './compat-path-safety.mjs';

/** Legacy single-file location (kept for read-fallback during/after migration). */
export const COMPAT_LEGACY_FILE = 'data/seo-404-compat-paths.json';

/** Directory that holds the shard files + manifest. */
export const COMPAT_SHARD_DIR = 'data/seo-404-compat';

/**
 * Number of shards. 16 keeps each shard ~6 MB at the current ~95 MB total,
 * with headroom to ~1.6 GB total before any shard nears the 100 MB limit
 * (a decade+ at the observed ~tens-of-MB/year growth). Changing this value
 * re-distributes every path on the next write, which is a one-time large diff
 * — pick generously and leave it.
 */
export const COMPAT_SHARD_COUNT = 16;

/**
 * Deterministic shard index for a path (FNV-1a hash, 32-bit, % count).
 * Delegates to the shared `scripts/lib/fnv1a.mjs` (AGENTS.md #6) — the exact
 * same algorithm as before, so the shard assignment is byte-identical and no
 * path gets redistributed (see this file's docblock).
 */
export function compatShardIndex(p, count = COMPAT_SHARD_COUNT) {
  return fnv1a32Mod(String(p), count);
}

/** Absolute path of shard `i`. */
export function compatShardFile(i, rootDir = process.cwd()) {
  return path.resolve(rootDir, COMPAT_SHARD_DIR, shardFileName(i));
}

/** Absolute path of the manifest. */
export function compatManifestFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, COMPAT_SHARD_DIR, 'manifest.json');
}

/** List existing shard files (absolute), sorted, or [] if the dir is absent. */
export function listCompatShardFiles(rootDir = process.cwd()) {
  return listShardFilesIn(path.resolve(rootDir, COMPAT_SHARD_DIR));
}

/**
 * Read the full logical accumulator: `{ ...meta, paths: string[] }`.
 *
 * Unions every shard's `paths` (de-duped, insertion order preserved). If no
 * shards exist yet, falls back to the legacy monolith so callers keep working
 * across the migration. Never throws — a corrupt shard is skipped, mirroring
 * the prior `readJsonSafe(file, { paths: [] })` contract every caller relied
 * on. This is intentionally the forgiving reader for non-destructive runtime
 * consumers; every caller that will write the accumulator must use
 * `readCompatPathsStrict()` below so a partial read cannot be persisted.
 */
export function readCompatPaths(rootDir = process.cwd()) {
  const shardFiles = listCompatShardFiles(rootDir);
  if (shardFiles.length > 0) {
    const seen = new Set();
    const paths = [];
    for (const f of shardFiles) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(j?.paths)) {
          for (const p of j.paths) {
            if (typeof p === 'string' && !seen.has(p)) {
              seen.add(p);
              paths.push(p);
            }
          }
        }
      } catch {
        /* skip corrupt/mid-write shard */
      }
    }
    let meta = {};
    try {
      const m = JSON.parse(fs.readFileSync(compatManifestFile(rootDir), 'utf-8'));
      if (m && typeof m === 'object') meta = m;
    } catch {
      /* manifest optional */
    }
    delete meta.paths;
    delete meta.shardCount;
    delete meta.totalPaths;
    return { ...meta, paths };
  }

  // Legacy fallback: single monolith.
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve(rootDir, COMPAT_LEGACY_FILE), 'utf-8'));
    if (j && typeof j === 'object') {
      const { paths: lp, ...rest } = j;
      delete rest.shardCount;
      delete rest.totalPaths;
      return { ...rest, paths: Array.isArray(lp) ? lp.filter((p) => typeof p === 'string') : [] };
    }
  } catch {
    /* nothing on disk */
  }
  return { paths: [] };
}

/**
 * Read the accumulator for a destructive rewrite. Unlike readCompatPaths(),
 * this fails closed if a shard or its manifest is missing, corrupt, or
 * inconsistent: a partial read must never be written back as the new set.
 * The merge-conflict resolver uses the separate
 * `readCompatPathsStrictAfterMerge()` entry point for its post-write invariant
 * check with an independently computed expected path count; shard
 * completeness, assignment, uniqueness, and that count remain mandatory.
 */
export function readCompatPathsStrict(rootDir = process.cwd()) {
  return readCompatPathsStrictInternal(rootDir);
}

/**
 * Validate all shards against the resolver's expected post-merge total. This
 * deliberately allows a stale manifest total for callers that validate before
 * refreshing metadata; it still
 * rejects missing/corrupt shards, duplicates, wrong assignments, invalid
 * manifest shape, and any mismatch with the resolver's independently
 * computed expected total. Callers outside
 * `resolve-404-compat-conflict.mjs` must use `readCompatPathsStrict()` instead.
 *
 * @param {string} rootDir
 * @param {number} expectedTotalPaths path count from the merged index stages
 * and all clean shards; never omit this safety check
 */
export function readCompatPathsStrictAfterMerge(rootDir = process.cwd(), expectedTotalPaths) {
  if (!Number.isSafeInteger(expectedTotalPaths) || expectedTotalPaths < 0) {
    throw new Error(
      '[compat-paths-store] resolver must provide a non-negative expected path count '
      + 'while recomputing the manifest',
    );
  }
  return readCompatPathsStrictInternal(rootDir, { expectedTotalPaths });
}

function readCompatPathsStrictInternal(rootDir, { expectedTotalPaths = null } = {}) {
  const dir = path.resolve(rootDir, COMPAT_SHARD_DIR);
  let shardNames;
  try {
    shardNames = fs.readdirSync(dir).filter((name) => SHARD_FILE_RE.test(name)).sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`[compat-paths-store] cannot list shards: ${err?.message ?? err}`);
    }

    const legacyFile = path.resolve(rootDir, COMPAT_LEGACY_FILE);
    let legacy;
    try {
      legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    } catch (legacyErr) {
      if (legacyErr?.code === 'ENOENT') {
        throw new Error(
          '[compat-paths-store] compatibility accumulator is missing; '
          + 'refusing to bootstrap a destructive rewrite from an empty checkout',
        );
      }
      throw new Error(`[compat-paths-store] cannot read legacy accumulator: ${legacyErr?.message ?? legacyErr}`);
    }
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || !Array.isArray(legacy.paths)
      || legacy.paths.some((p) => typeof p !== 'string')) {
      throw new Error('[compat-paths-store] invalid legacy accumulator; refusing destructive rewrite');
    }
    const { paths: legacyPaths, ...meta } = legacy;
    delete meta.shardCount;
    delete meta.totalPaths;
    const paths = [...new Set(legacyPaths)];
    if (expectedTotalPaths !== null && paths.length !== expectedTotalPaths) {
      throw new Error(
        `[compat-paths-store] legacy accumulator contains ${paths.length} paths, `
        + `but the resolver expected ${expectedTotalPaths}; refusing destructive rewrite`,
      );
    }
    return { ...meta, paths };
  }

  const expectedShardNames = Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) => shardFileName(i));
  const shardNameSet = new Set(shardNames);
  const missingShards = expectedShardNames.filter((name) => !shardNameSet.has(name));
  if (shardNames.length !== COMPAT_SHARD_COUNT || missingShards.length > 0) {
    throw new Error(
      `[compat-paths-store] incomplete shard set (${shardNames.length}/${COMPAT_SHARD_COUNT}); `
      + `missing: ${missingShards.slice(0, 5).join(', ') || '(unexpected shard names)'}`,
    );
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(compatManifestFile(rootDir), 'utf-8'));
  } catch (err) {
    throw new Error(`[compat-paths-store] cannot read shard manifest: ${err?.message ?? err}`);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || meta.shardCount !== COMPAT_SHARD_COUNT
    || !Number.isSafeInteger(meta.totalPaths) || meta.totalPaths < 0) {
    throw new Error('[compat-paths-store] invalid shard manifest; refusing destructive rewrite');
  }

  const seen = new Set();
  const paths = [];
  for (const name of shardNames) {
    const file = path.join(dir, name);
    const shardIndex = Number(name.slice('part-'.length, -'.json'.length));
    if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= COMPAT_SHARD_COUNT) {
      throw new Error(`[compat-paths-store] invalid shard name ${name}; refusing destructive rewrite`);
    }
    let shard;
    try {
      shard = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new Error(`[compat-paths-store] cannot read ${name}: ${err?.message ?? err}`);
    }
    if (!shard || typeof shard !== 'object' || Array.isArray(shard) || !Array.isArray(shard.paths)
      || shard.paths.some((p) => typeof p !== 'string')) {
      throw new Error(`[compat-paths-store] invalid ${name}; refusing destructive rewrite`);
    }
    for (const p of shard.paths) {
      if (seen.has(p)) {
        throw new Error(`[compat-paths-store] duplicate path ${p} across shards; refusing destructive rewrite`);
      }
      if (compatShardIndex(p) !== shardIndex) {
        throw new Error(
          `[compat-paths-store] ${name} contains path assigned to shard ${compatShardIndex(p)}: ${p}; `
          + 'refusing destructive rewrite',
        );
      }
      seen.add(p);
      paths.push(p);
    }
  }

  if (expectedTotalPaths !== null && paths.length !== expectedTotalPaths) {
    throw new Error(
      `[compat-paths-store] merged shards contain ${paths.length} paths, `
      + `but the resolver expected ${expectedTotalPaths}; refusing destructive rewrite`,
    );
  }

  if (expectedTotalPaths === null && paths.length !== meta.totalPaths) {
    throw new Error(
      `[compat-paths-store] manifest declares ${meta.totalPaths} paths, `
      + `but complete shards contain ${paths.length}; refusing destructive rewrite`,
    );
  }

  delete meta.paths;
  delete meta.shardCount;
  delete meta.totalPaths;
  return { ...meta, paths };
}

/**
 * Write the full logical accumulator across the shards + manifest.
 *
 * `data` is `{ ...meta, paths }`; `paths` is de-duped, distributed by
 * `compatShardIndex`, each shard sorted for a stable diff. Meta (everything
 * except `paths`) goes to the manifest. The legacy monolith is removed if
 * present (it cannot be pushed). Returns `{ totalPaths, shardCount,
 * shardsWritten }`.
 *
 * Only shards whose serialized content actually differs from what's on disk
 * are written (2026-08-30, issue #6384): with 146 commits/30d touching this
 * directory and most persists changing a handful of paths, unconditionally
 * rewriting all 16 shards every call inflated every commit's diff (and the
 * repo's git history weight) 16x beyond the real change. Comparing the
 * about-to-be-written bytes against the existing file before writing keeps
 * the shard set byte-identical run to run wherever nothing changed, with no
 * change to the logical read/write contract.
 */
export function writeCompatPaths(data, rootDir = process.cwd()) {
  const { paths: rawPaths, ...meta } = data || {};
  delete meta.shardCount;
  delete meta.totalPaths;
  const filtered = filterCompatPaths(rawPaths);
  if (filtered.dropped.length > 0) {
    const byReason = filtered.dropped.reduce((counts, { reason }) => {
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    console.warn(
      `[compat-paths-store] dropped ${filtered.dropped.length} unsafe path(s) before persist `
      + `(filesystem-limit=${byReason['filesystem-limit'] || 0}, attack-payload=${byReason['attack-payload'] || 0})`,
    );
  }
  const uniq = [...new Set(filtered.paths)];

  const buckets = Array.from({ length: COMPAT_SHARD_COUNT }, () => []);
  for (const p of uniq) buckets[compatShardIndex(p)].push(p);

  const dir = path.resolve(rootDir, COMPAT_SHARD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  let shardsWritten = 0;
  for (let i = 0; i < COMPAT_SHARD_COUNT; i++) {
    buckets[i].sort();
    const content = JSON.stringify({ paths: buckets[i] }, null, 2) + '\n';
    const file = compatShardFile(i, rootDir);
    if (writeShardFileIfChanged(file, content)) shardsWritten++;
  }
  writeFileAtomic(
    compatManifestFile(rootDir),
    JSON.stringify({ ...meta, shardCount: COMPAT_SHARD_COUNT, totalPaths: uniq.length }, null, 2) + '\n',
  );

  // The monolith is unpushable (>100 MB) and now superseded — drop it.
  try {
    const legacy = path.resolve(rootDir, COMPAT_LEGACY_FILE);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
  } catch {
    /* best-effort */
  }

  return {
    totalPaths: uniq.length,
    shardCount: COMPAT_SHARD_COUNT,
    shardsWritten,
    filteredPaths: filtered.dropped.length,
  };
}
