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
 * Iterate the logical accumulator without retaining every path at once.
 *
 * Build-time consumers that only need to inspect each path (rather than return
 * the complete set) must use this generator. The normal reader intentionally
 * keeps its forgiving, de-duplicating return contract; this one keeps only the
 * current shard's parsed array alive, which is important when the accumulator
 * contains millions of paths and the caller is already holding a large SEO
 * route registry.
 *
 * Shard files are the canonical representation and are internally validated
 * by the writers. A duplicate path therefore has no semantic effect for a
 * streaming inspection: callers that need the strict uniqueness invariant use
 * `readCompatPathsStrict()` instead.
 *
 * @param {string} [rootDir]
 * @returns {Generator<string>}
 */
export function* iterateCompatPaths(rootDir = process.cwd()) {
  const shardFiles = listCompatShardFiles(rootDir);
  if (shardFiles.length > 0) {
    for (const file of shardFiles) {
      let shard;
      try {
        shard = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        /* keep the forgiving runtime contract: skip a corrupt shard */
        continue;
      }
      if (!Array.isArray(shard?.paths)) continue;
      for (const value of shard.paths) {
        if (typeof value === 'string') yield value;
      }
    }
    return;
  }

  // Legacy fallback for checkouts that predate the sharded accumulator.
  try {
    const legacy = JSON.parse(fs.readFileSync(path.resolve(rootDir, COMPAT_LEGACY_FILE), 'utf-8'));
    if (!legacy || typeof legacy !== 'object' || !Array.isArray(legacy.paths)) return;
    for (const value of legacy.paths) {
      if (typeof value === 'string') yield value;
    }
  } catch {
    /* no accumulator on disk */
  }
}

/**
 * Options for `readCompatPathsStrict()` in the pure readers and the producers
 * that merge new observations into the set (discover-404s-*, sync-gsc-orphans,
 * ingest-gsc-coverage-404s, mine-all-job-slugs, build-search-cluster-301-map):
 * each rewrites through `writeCompatPaths` behind `assertCompatFloor`, so a
 * manifest total that merely LAGS the shards cannot make them lose anything
 * (discover-404s-via-inspection also drops the few URLs it has just proved
 * recovered, bounded by its batch). The prune and the merge resolver, which
 * remove paths by rule over the whole set, must not use it
 * (tests/compat-manifest-lag.test.ts pins both lists).
 */
export const ADDITIVE_COMPAT_READ = Object.freeze({ allowManifestSurplus: true });

/**
 * Read the accumulator for a destructive rewrite. Unlike readCompatPaths(),
 * this fails closed if a shard or its manifest is missing, corrupt, or
 * inconsistent: a partial read must never be written back as the new set.
 * The merge-conflict resolver uses the separate
 * `readCompatPathsStrictAfterMerge()` entry point for its post-write invariant
 * check with an independently computed expected path count; shard
 * completeness, assignment, uniqueness, and that count remain mandatory.
 *
 * `options.allowManifestSurplus` (default false) is for pure readers and the
 * producers that merge new observations into the set and rewrite it through
 * `writeCompatPaths` (which recomputes the manifest) behind `assertCompatFloor`
 * (see `ADDITIVE_COMPAT_READ`): a manifest `totalPaths` LOWER than the complete,
 * valid, unique, correctly assigned shards loses nothing (a merge unioned the
 * shards without refreshing the manifest, 2026-11-15, build 43728895227), so
 * it is reported through `onManifestSurplus` (default: a `console.warn`) and
 * the read proceeds. A `totalPaths` HIGHER than the shards (possible
 * truncation) and every other check stay fatal. Removers (the prune and the
 * merge resolver) keep the default exact mode.
 */
export function readCompatPathsStrict(rootDir = process.cwd(), options = {}) {
  const { allowManifestSurplus = false, onManifestSurplus } = options ?? {};
  return readCompatPathsStrictInternal(rootDir, {
    manifestTotal: allowManifestSurplus ? 'allow-surplus' : 'exact',
    onManifestSurplus,
  });
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

/**
 * Repair only stale manifest metadata after the complete shard set has been
 * validated. Shard contents are never rewritten here: a stale count is a
 * recoverable merge-order artifact, while missing/corrupt/duplicate/wrongly
 * assigned shard data remains a hard failure.
 *
 * This is intentionally separate from readCompatPathsStrict(). Consumers that
 * are about to mine or append the accumulator may opt into this metadata-only
 * recovery; strict readers keep rejecting stale manifests so a caller cannot
 * accidentally treat an unvalidated store as safe.
 */
function repairCompatManifestFromValidated(rootDir, validated) {
  const dir = path.resolve(rootDir, COMPAT_SHARD_DIR);
  let shardNames;
  try {
    shardNames = fs.readdirSync(dir).filter((name) => SHARD_FILE_RE.test(name)).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { changed: false, totalPaths: null, previousTotalPaths: null };
    }
    throw new Error(`[compat-paths-store] cannot list shards: ${err?.message ?? err}`);
  }

  // A non-empty directory with no canonical shards is not a safe repair target.
  // Let the strict validator produce the existing fail-closed error instead of
  // guessing whether a legacy or partial migration is intended.
  if (shardNames.length === 0) {
    throw new Error('[compat-paths-store] compatibility shard directory has no canonical shards; refusing manifest repair');
  }

  const manifestPath = compatManifestFile(rootDir);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`[compat-paths-store] cannot read shard manifest: ${err?.message ?? err}`);
  }

  const { paths: _manifestPaths, ...manifestMeta } = manifest;
  const nextManifest = {
    ...manifestMeta,
    shardCount: COMPAT_SHARD_COUNT,
    totalPaths: validated.paths.length,
  };
  const nextContent = JSON.stringify(nextManifest, null, 2) + '\n';
  const currentContent = fs.readFileSync(manifestPath, 'utf-8');
  const changed = currentContent !== nextContent;
  if (changed) writeFileAtomic(manifestPath, nextContent);

  return {
    changed,
    totalPaths: validated.paths.length,
    previousTotalPaths: manifest.totalPaths,
  };
}

export function repairCompatManifest(rootDir = process.cwd()) {
  const validated = readCompatPathsStrictInternal(rootDir, { allowStaleManifest: true });
  return repairCompatManifestFromValidated(rootDir, validated);
}

/**
 * Strictly read the store and repair only its derived manifest metadata in the
 * same validation pass. The returned `data` is safe for a destructive writer;
 * `changed` describes whether the manifest was rewritten.
 */
export function readCompatPathsStrictWithManifestRepair(rootDir = process.cwd()) {
  const data = readCompatPathsStrictInternal(rootDir, { allowStaleManifest: true });
  return {
    data,
    ...repairCompatManifestFromValidated(rootDir, data),
  };
}

function readCompatPathsStrictInternal(
  rootDir,
  {
    expectedTotalPaths = null,
    manifestTotal = 'exact',
    onManifestSurplus,
    allowStaleManifest = false,
  } = {},
) {
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

  const declaredTotalPaths = meta.totalPaths;
  if (
    expectedTotalPaths === null
    && !allowStaleManifest
    && manifestTotal !== 'ignore'
    && paths.length !== declaredTotalPaths
  ) {
    if (manifestTotal === 'allow-surplus' && paths.length > declaredTotalPaths) {
      const report = onManifestSurplus ?? ((info) => console.warn(info.message));
      report({
        declaredTotalPaths,
        actualTotalPaths: paths.length,
        message: `[compat-paths-store] WARNING manifest totalPaths lags its shards: manifest declares ${declaredTotalPaths} paths, `
          + `complete shards contain ${paths.length} (+${paths.length - declaredTotalPaths}); the shards are complete, `
          + 'unique and correctly assigned, so nothing is lost; continuing. '
          + 'Realign with: node scripts/ci/refresh-compat-manifest.mjs',
      });
    } else {
      throw new Error(
        `[compat-paths-store] manifest declares ${declaredTotalPaths} paths, `
        + `but complete shards contain ${paths.length}; refusing destructive rewrite`,
      );
    }
  }

  delete meta.paths;
  delete meta.shardCount;
  delete meta.totalPaths;
  return { ...meta, paths };
}

/**
 * Realign `manifest.json`'s `totalPaths` with the shards it describes.
 *
 * A merge that unions the shards (the `merge=compat-shard` driver, or GitHub's
 * own text merge) without going through `writeCompatPaths` leaves the manifest
 * with the total of ONE side, so `readCompatPathsStrict()` then refuses every
 * read (2026-11-15: manifest 6411550 vs 6411560 in the shards, build
 * 43728895227). The shards are the source of truth: this validates them with
 * every check of the strict reader (complete set, valid JSON, string paths, no
 * duplicates, correct shard assignment) and only then rewrites the manifest
 * with the byte-identical serialisation of `writeCompatPaths`, preserving
 * `source`/`lastUpdated` and any other metadata. No shard is ever touched. A
 * corrupt or incomplete shard set throws: it is never "fixed" by re-counting.
 *
 * @param {string} [rootDir]
 * @param {{ check?: boolean }} [options] `check: true` reports without writing
 * @returns {{ declaredTotalPaths: number|null, actualTotalPaths: number, changed: boolean, skipped?: string }}
 */
export function refreshCompatManifest(rootDir = process.cwd(), { check = false } = {}) {
  if (listCompatShardFiles(rootDir).length === 0) {
    return { declaredTotalPaths: null, actualTotalPaths: 0, changed: false, skipped: 'no-shards' };
  }
  const store = readCompatPathsStrictInternal(rootDir, { manifestTotal: 'ignore' });
  const manifestFile = compatManifestFile(rootDir);
  const raw = fs.readFileSync(manifestFile, 'utf-8');
  const declared = JSON.parse(raw)?.totalPaths;
  const { paths, ...meta } = store;
  const content = JSON.stringify(
    { ...meta, shardCount: COMPAT_SHARD_COUNT, totalPaths: paths.length },
    null,
    2,
  ) + '\n';
  const changed = content !== raw;
  if (changed && !check) writeFileAtomic(manifestFile, content);
  return {
    declaredTotalPaths: Number.isSafeInteger(declared) ? declared : null,
    actualTotalPaths: paths.length,
    changed,
  };
}

/**
 * Write the full logical accumulator across the shards + manifest.
 *
 * `data` is `{ ...meta, paths }`; `paths` is de-duped, distributed by
 * `compatShardIndex`, each shard sorted for a stable diff. Meta (everything
 * except `paths`) goes to the manifest. The legacy monolith is removed if
 * present (it cannot be pushed). Unsafe externally observed paths are rejected
 * here as the single data-ingress gate and reported before the write. Returns
 * both `filteredPaths` (the branch contract) and `rejectedPaths` (the main-side
 * alias) for callers that need the count.
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
    rejectedPaths: filtered.dropped.length,
  };
}
