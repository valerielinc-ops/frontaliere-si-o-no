/**
 * Sharded store for the `data/all-known-job-slugs.json` accumulator
 * (the canonical slug registry: `{ "<canonical-slug>": { it, en, de, fr } }`).
 *
 * Why this exists (2026-08-05, issue #4248): the registry is a single committed
 * JSON file that grows monotonically — every writer merges into what it read
 * (`readJson(trackingFile) || {}`), nothing regenerates it from scratch, so a
 * slug whose source job was pruned survives only here. It crossed GitHub's HARD
 * 100 MB per-file push limit:
 *
 *   remote: error: File data/all-known-job-slugs.json is 116.36 MB; this
 *   exceeds GitHub's file size limit of 100.00 MB
 *   remote: error: GH001: Large files detected.
 *   ! [remote rejected] ... -> main (pre-receive hook declined)
 *
 * `sync-gsc-orphans.yml` has been red on EVERY run since 2026-07-17 (0/100
 * successes) because of it. That workflow is what feeds the 404 soft-landing
 * registry, so for three weeks every URL Search Console reported as a 404 kept
 * 404-ing instead of landing on a useful page — compounding organic-traffic
 * loss, not a cosmetic red badge.
 *
 * Minifying was measured first and recovers only ~5% (the payload is long
 * locale paths, not whitespace), and deleting is not an option: the file is an
 * accumulator, so a rebuild would silently drop every historical slug whose
 * source has since been pruned.
 *
 * Fix (lossless): split the one monolith into a fixed set of plain-JSON-text
 * shards under `data/all-known-job-slugs/part-NN.json`, each well under the
 * limit. No slug is dropped — the logical model is still ONE
 * `{ slug: { locale: path } }` map, reconstructed by merging the shards.
 *
 * This is the SAME shape of fix, deliberately built on the SAME primitives, as
 * `scripts/lib/compat-paths-store.mjs` (issue #2988, which split
 * `data/seo-404-compat-paths.json` the same way). Design constraints carried
 * over verbatim:
 *  - Plain JSON TEXT per shard (no gzip/binary): git's text diff and the 3-way
 *    merge across concurrent `main` writers must keep working.
 *  - DETERMINISTIC slug→shard assignment (`fnv1a32Mod`, the shared hash in
 *    `scripts/lib/fnv1a.mjs`): a given slug always lands in the same shard, so
 *    a per-shard 3-way merge is correct and only the shards that actually
 *    changed diff on each write.
 *  - Each shard's keys are SORTED, so appending a few slugs produces a small
 *    delta instead of rewriting the whole blob.
 *  - Metadata lives in a tiny separate `manifest.json`, never in the shards, so
 *    an unchanged shard stays byte-identical run to run.
 *
 * Single source of truth (AGENTS.md #6): every reader/writer of the registry
 * goes through `readAllKnownJobSlugs` / `writeAllKnownJobSlugs` here instead of
 * hand-rolling `JSON.parse(fs.readFileSync('data/all-known-job-slugs.json'))`.
 * That matters more here than usual: ~20 call sites read this file and almost
 * every one of them degrades to `{}` on failure (`readJsonSafe(...) || {}`, or
 * a swallowing catch that starts fresh). A half-migrated reader would therefore
 * NOT throw — it would quietly see an empty registry and emit a build with no
 * soft landings at all. `tests/all-known-job-slugs-store.test.ts` fails the
 * build if any reader goes back to touching the monolith directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fnv1a32Mod } from './fnv1a.mjs';
import { shardFileName, listShardFilesIn } from './shard-file-naming.mjs';
import { writeShardFileIfChanged, writeFileAtomic } from './atomic-shard-write.mjs';

/** Legacy single-file location (kept for read-fallback during/after migration). */
export const KNOWN_SLUGS_LEGACY_FILE = 'data/all-known-job-slugs.json';

/** Directory that holds the shard files + manifest. */
export const KNOWN_SLUGS_SHARD_DIR = 'data/all-known-job-slugs';

/**
 * Number of shards. At migration time the registry held 194,192 slugs / 95.5 MB
 * and grows ~1 MB/day (it went from "comfortable" to over the limit in about
 * five weeks). 32 shards puts each one at ~3 MB today with headroom to ~3.2 GB
 * total before any single shard nears 100 MB — roughly 8 years at the observed
 * rate, versus ~4 years at 16. Changing this value re-distributes every slug on
 * the next write, which is a one-time whole-registry diff — pick generously and
 * leave it.
 */
export const KNOWN_SLUGS_SHARD_COUNT = 32;

/**
 * Deterministic shard index for a slug (FNV-1a, 32-bit, % count) via the shared
 * `scripts/lib/fnv1a.mjs` — the same primitive `compatShardIndex` uses, so the
 * two stores cannot drift apart on the hash (AGENTS.md #6).
 */
export function knownSlugsShardIndex(slug, count = KNOWN_SLUGS_SHARD_COUNT) {
  return fnv1a32Mod(String(slug), count);
}

/** Absolute path of shard `i`. */
export function knownSlugsShardFile(i, rootDir = process.cwd()) {
  return path.resolve(rootDir, KNOWN_SLUGS_SHARD_DIR, shardFileName(i));
}

/** Absolute path of the manifest. */
export function knownSlugsManifestFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, KNOWN_SLUGS_SHARD_DIR, 'manifest.json');
}

/** Absolute path of the legacy monolith. */
export function knownSlugsLegacyFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, KNOWN_SLUGS_LEGACY_FILE);
}

/** List existing shard files (absolute), sorted, or [] if the dir is absent. */
export function listKnownSlugsShardFiles(rootDir = process.cwd()) {
  return listShardFilesIn(path.resolve(rootDir, KNOWN_SLUGS_SHARD_DIR));
}

/**
 * True when the sharded store is present on disk. Readers that used to call
 * `fs.existsSync('data/all-known-job-slugs.json')` before doing work use this
 * so "registry absent" keeps meaning the same thing after the split.
 */
export function knownSlugsStoreExists(rootDir = process.cwd()) {
  if (listKnownSlugsShardFiles(rootDir).length > 0) return true;
  return fs.existsSync(knownSlugsLegacyFile(rootDir));
}

/**
 * `__proto__` can never be a real slug (slugs are `[a-z0-9-]` and never start
 * with `_`), but assigning it with `obj[k] = v` would hit the prototype setter
 * instead of creating an own property — unlike `JSON.parse`, which the callers
 * used before. Skipping it keeps the merged object exactly as safe as the
 * single `JSON.parse` it replaces.
 */
/**
 * @param {Record<string, Record<string, string>>} target
 * @param {unknown} source
 */
function assignEntries(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const k of Object.keys(source)) {
    if (k === '__proto__') continue;
    target[k] = source[k];
  }
}

/**
 * Read the full logical registry: `{ [slug]: { [locale]: path } }`.
 *
 * Merges every shard's `slugs` map. If a legacy monolith is ALSO on disk (a
 * checkout that predates the split, or a stale writer that re-created it) its
 * entries are merged in FIRST, so shards win on conflict — lossless in both
 * directions, and no reader can regress to an empty registry mid-transition.
 *
 * Never throws — a corrupt/mid-write shard is skipped, mirroring the
 * `readJsonSafe(file) || {}` contract every caller relied on. Peak memory is
 * lower than the monolith it replaces: one shard's text is parsed and merged
 * before the next is read, instead of holding a 95 MB string and its parse
 * result at the same time.
 *
 * @param {string} [rootDir]
 * @returns {Record<string, Record<string, string>>}
 */
export function readAllKnownJobSlugs(rootDir = process.cwd()) {
  /** @type {Record<string, Record<string, string>>} */
  const out = {};

  // Legacy monolith first (if any) so shard entries override it.
  try {
    const j = JSON.parse(fs.readFileSync(knownSlugsLegacyFile(rootDir), 'utf-8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) assignEntries(out, j);
  } catch {
    /* absent or unparseable — the shards are the normal source */
  }

  for (const f of listKnownSlugsShardFiles(rootDir)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (j && typeof j.slugs === 'object' && j.slugs !== null) assignEntries(out, j.slugs);
    } catch {
      /* skip corrupt/mid-write shard */
    }
  }

  return out;
}

/**
 * Write the full logical registry across the shards + manifest.
 *
 * Keys are distributed by `knownSlugsShardIndex` and each shard is written with
 * its keys SORTED, for a stable, minimal diff. The legacy monolith is removed
 * if present — it cannot be pushed, and leaving it would let a stale reader
 * serve pre-split data. Returns `{ totalSlugs, shardCount }`.
 *
 * @param {Record<string, Record<string, string>>} registry
 * @param {string} [rootDir]
 * @returns {{ totalSlugs: number, shardCount: number }}
 */
export function writeAllKnownJobSlugs(registry, rootDir = process.cwd()) {
  const src = registry && typeof registry === 'object' ? registry : {};

  const buckets = Array.from({ length: KNOWN_SLUGS_SHARD_COUNT }, () => []);
  for (const slug of Object.keys(src)) {
    if (slug === '__proto__') continue;
    const v = src[slug];
    if (!v || typeof v !== 'object') continue;
    buckets[knownSlugsShardIndex(slug)].push(slug);
  }

  const dir = path.resolve(rootDir, KNOWN_SLUGS_SHARD_DIR);
  fs.mkdirSync(dir, { recursive: true });

  let total = 0;
  for (let i = 0; i < KNOWN_SLUGS_SHARD_COUNT; i++) {
    buckets[i].sort();
    const slugs = {};
    for (const slug of buckets[i]) slugs[slug] = src[slug];
    total += buckets[i].length;
    const content = JSON.stringify({ slugs }, null, 2) + '\n';
    const file = knownSlugsShardFile(i, rootDir);
    writeShardFileIfChanged(file, content);
  }

  writeFileAtomic(
    knownSlugsManifestFile(rootDir),
    JSON.stringify({ shardCount: KNOWN_SLUGS_SHARD_COUNT, totalSlugs: total }, null, 2) + '\n',
  );

  // The monolith is unpushable (>100 MB) and now superseded — drop it.
  try {
    const legacy = knownSlugsLegacyFile(rootDir);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
  } catch {
    /* best-effort */
  }

  return { totalSlugs: total, shardCount: KNOWN_SLUGS_SHARD_COUNT };
}
