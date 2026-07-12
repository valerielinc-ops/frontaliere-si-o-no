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

const SHARD_RE = /^part-\d+\.json$/;

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
  return path.resolve(rootDir, COMPAT_SHARD_DIR, `part-${String(i).padStart(2, '0')}.json`);
}

/** Absolute path of the manifest. */
export function compatManifestFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, COMPAT_SHARD_DIR, 'manifest.json');
}

/** List existing shard files (absolute), sorted, or [] if the dir is absent. */
export function listCompatShardFiles(rootDir = process.cwd()) {
  const dir = path.resolve(rootDir, COMPAT_SHARD_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => SHARD_RE.test(f));
  } catch {
    return [];
  }
  names.sort();
  return names.map((n) => path.join(dir, n));
}

/**
 * Read the full logical accumulator: `{ ...meta, paths: string[] }`.
 *
 * Unions every shard's `paths` (de-duped, insertion order preserved). If no
 * shards exist yet, falls back to the legacy monolith so callers keep working
 * across the migration. Never throws — a corrupt shard is skipped, mirroring
 * the prior `readJsonSafe(file, { paths: [] })` contract every caller relied
 * on (a hard-fail here would be the truncation hazard, not a fix).
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
 * Write the full logical accumulator across the shards + manifest.
 *
 * `data` is `{ ...meta, paths }`; `paths` is de-duped, distributed by
 * `compatShardIndex`, each shard sorted for a stable diff. Meta (everything
 * except `paths`) goes to the manifest. The legacy monolith is removed if
 * present (it cannot be pushed). Returns `{ totalPaths, shardCount }`.
 */
export function writeCompatPaths(data, rootDir = process.cwd()) {
  const { paths: rawPaths, ...meta } = data || {};
  delete meta.shardCount;
  delete meta.totalPaths;
  const uniq = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).filter((p) => typeof p === 'string'))];

  const buckets = Array.from({ length: COMPAT_SHARD_COUNT }, () => []);
  for (const p of uniq) buckets[compatShardIndex(p)].push(p);

  const dir = path.resolve(rootDir, COMPAT_SHARD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < COMPAT_SHARD_COUNT; i++) {
    buckets[i].sort();
    fs.writeFileSync(compatShardFile(i, rootDir), JSON.stringify({ paths: buckets[i] }, null, 2) + '\n', 'utf-8');
  }
  fs.writeFileSync(
    compatManifestFile(rootDir),
    JSON.stringify({ ...meta, shardCount: COMPAT_SHARD_COUNT, totalPaths: uniq.length }, null, 2) + '\n',
    'utf-8',
  );

  // The monolith is unpushable (>100 MB) and now superseded — drop it.
  try {
    const legacy = path.resolve(rootDir, COMPAT_LEGACY_FILE);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
  } catch {
    /* best-effort */
  }

  return { totalPaths: uniq.length, shardCount: COMPAT_SHARD_COUNT };
}
