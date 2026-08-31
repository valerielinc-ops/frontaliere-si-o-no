/**
 * Sharded store for the `data/orphan-enriched-data.json` accumulator — the
 * enrichment ledger for orphan job slugs (GSC queries + impressions, translated
 * titles/descriptions, company/location), keyed by the URL Search Console
 * indexed but the site no longer serves.
 *
 * Why this exists (2026-08-05, issue #4248 — second half)
 * ------------------------------------------------------
 * `sync-gsc-orphans.yml` has been red on EVERY run since 2026-07-17. The push
 * carries two accumulators and BOTH crossed GitHub's hard 100 MB per-blob push
 * limit, so `git push` was rejected by the pre-receive hook:
 *
 *   remote: error: File data/all-known-job-slugs.json is 116.78 MB; this
 *   exceeds GitHub's file size limit of 100.00 MB
 *   remote: error: File data/orphan-enriched-data.json is 111.90 MB; this
 *   exceeds GitHub's file size limit of 100.00 MB
 *   remote: error: GH001: Large files detected.
 *   ! [remote rejected] ... -> main (pre-receive hook declined)
 *
 * PR #5146 sharded the first file. This module is the SAME fix for the second,
 * and it is what actually unblocks the push — GH001 fails the whole push if any
 * ONE blob is over the limit, so fixing one of two files changed nothing that a
 * run could observe. Until both fit, the 404-compat feedback never reaches
 * `main`, no soft landings are generated, and every URL Search Console reports
 * as a 404 keeps 404-ing: compounding organic-traffic loss on the highest-volume
 * surface of the site (23k+ job URLs), not a cosmetic red badge.
 *
 * Why not just shrink it
 * ----------------------
 * It is an accumulator: step 2c of `sync-gsc-orphans.mjs` re-reads it and
 * preserves every previously-enriched record, because the enrichment (GSC
 * queries, titles, company) is what makes a soft-landing page useful instead of
 * a generic fallback. Nothing regenerates it, so a rebuild silently drops every
 * historical orphan whose GSC signal has since aged out of the 16-month window.
 * It is also already de-duplicated: PR #5117 collapsed the ×4 per-locale
 * amplification (285 MB → 112 MB). What remains is real, and it grows.
 *
 * Fix (lossless): split the monolith into a fixed set of plain-JSON-text shards
 * under `data/orphan-enriched-data/part-NN.json`, each well under the limit.
 * The logical model is still ONE array of enriched records, reconstructed by
 * concatenating the shards. Same shape of fix, same primitives, as the two
 * stores that came before it — `scripts/lib/compat-paths-store.mjs` (#2988) and
 * `scripts/lib/all-known-job-slugs-store.mjs` (#4248 first half). Design
 * constraints carried over verbatim:
 *  - Plain JSON TEXT per shard (no gzip/binary): git's text diff and the 3-way
 *    merge across concurrent `main` writers must keep working.
 *  - DETERMINISTIC slug→shard assignment (`fnv1a32Mod`, the shared hash in
 *    `scripts/lib/fnv1a.mjs`): a given slug always lands in the same shard, so
 *    a per-shard 3-way merge is correct and only the shards that actually
 *    changed diff on each write.
 *  - Records SORTED inside each shard, so appending a few orphans produces a
 *    small delta instead of rewriting a ~3 MB blob (×32, on every run).
 *  - Metadata in a tiny separate `manifest.json`, never in the shards, so an
 *    unchanged shard stays byte-identical run to run.
 *
 * Single source of truth (AGENTS.md #6): every reader/writer goes through
 * `readOrphanEnriched` / `writeOrphanEnriched` instead of hand-rolling
 * `JSON.parse(fs.readFileSync('data/orphan-enriched-data.json'))`. That matters
 * more here than usual: every one of the call sites degrades to `[]` on failure
 * (`readJsonSafe(path, [])`, or a `catch` that swallows a missing file).
 * A half-migrated reader would therefore NOT throw — it would quietly see
 * zero enriched orphans and emit soft-landing pages stripped of their GSC
 * content, with green tests and a green deploy.
 * `tests/orphan-enriched-store.test.ts` fails the build if any source outside
 * this module names the monolith in a path-shaped string literal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fnv1a32Mod } from './fnv1a.mjs';
import { shardFileName, listShardFilesIn } from './shard-file-naming.mjs';
import { writeShardFileIfChanged, writeFileAtomic } from './atomic-shard-write.mjs';

/** Legacy single-file location (kept for read-fallback during/after migration). */
export const ORPHAN_ENRICHED_LEGACY_FILE = 'data/orphan-enriched-data.json';

/** Directory that holds the shard files + manifest. */
export const ORPHAN_ENRICHED_SHARD_DIR = 'data/orphan-enriched-data';

/**
 * Number of shards. At migration time the ledger held 29,386 records / 61.5 MB
 * committed, and the run that regenerates it produced 43,977 records / 111.9 MB
 * — the growth is real (22,165 supplementary orphans arrived from the 404-compat
 * store in a single run once three weeks of backlog unblocked). 32 shards puts
 * each at ~2 MB today, ~3.5 MB at the regenerated size, with headroom to ~3.2 GB
 * total before any single shard nears 100 MB. Matches
 * `KNOWN_SLUGS_SHARD_COUNT`, deliberately: the two stores are written by the
 * same scripts in the same runs, and one shard count is one thing to reason
 * about. Changing this value re-distributes every record on the next write,
 * which is a one-time whole-ledger diff — pick generously and leave it.
 */
export const ORPHAN_ENRICHED_SHARD_COUNT = 32;

/**
 * Record identity: `slug` + `locale`.
 *
 * This is NOT a new invention — it is the identity `sync-gsc-orphans.mjs` step
 * 2c already enforces when it merges the previous run's ledger
 * (`currentKeys` holds `` `${o.locale}:${o.slug}` ``). Making the store use the
 * same key means the round-trip cannot introduce or drop a record the pipeline
 * itself would consider distinct, and the `|| 'it'` default matches step 2c's
 * own `prev.locale || 'it'`. A locale is a 2-letter code and a slug never
 * contains `:`, so the two halves cannot run together ambiguously.
 */
export function orphanRecordKey(record) {
  return `${record?.locale || 'it'}:${record?.slug ?? ''}`;
}

/**
 * Deterministic shard index for a slug (FNV-1a, 32-bit, % count) via the shared
 * `scripts/lib/fnv1a.mjs` — the same primitive `compatShardIndex` and
 * `knownSlugsShardIndex` use, so the three stores cannot drift apart on the
 * hash (AGENTS.md #6).
 *
 * Sharding on `slug` alone (not slug+locale) is load-bearing: every locale
 * sibling of a slug lands in the SAME shard, so the "which record wins for this
 * slug" resolution below is decided inside one file and can never depend on the
 * order shards happen to be read in.
 */
export function orphanEnrichedShardIndex(slug, count = ORPHAN_ENRICHED_SHARD_COUNT) {
  return fnv1a32Mod(String(slug), count);
}

/** Absolute path of shard `i`. */
export function orphanEnrichedShardFile(i, rootDir = process.cwd()) {
  return path.resolve(rootDir, ORPHAN_ENRICHED_SHARD_DIR, shardFileName(i));
}

/** Absolute path of the manifest. */
export function orphanEnrichedManifestFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, ORPHAN_ENRICHED_SHARD_DIR, 'manifest.json');
}

/** Absolute path of the legacy monolith. */
export function orphanEnrichedLegacyFile(rootDir = process.cwd()) {
  return path.resolve(rootDir, ORPHAN_ENRICHED_LEGACY_FILE);
}

/** List existing shard files (absolute), sorted, or [] if the dir is absent. */
export function listOrphanEnrichedShardFiles(rootDir = process.cwd()) {
  return listShardFilesIn(path.resolve(rootDir, ORPHAN_ENRICHED_SHARD_DIR));
}

/**
 * True when the ledger is present on disk in either form. Readers that used to
 * call `fs.existsSync('data/orphan-enriched-data.json')` before doing work use
 * this, so "ledger absent" keeps meaning the same thing after the split.
 */
export function orphanEnrichedStoreExists(rootDir = process.cwd()) {
  if (listOrphanEnrichedShardFiles(rootDir).length > 0) return true;
  return fs.existsSync(orphanEnrichedLegacyFile(rootDir));
}

/**
 * Search-signal rank of a record, ascending — the ordering key applied WITHIN a
 * slug by `readOrphanEnriched`.
 *
 * Why this exists at all: every consumer of the ledger indexes it by slug with
 * LAST-ONE-WINS (`orphanGscData.set(entry.slug, data)` in
 * build-plugins/jobsSeoPagesPlugin.ts, `enrichmentBySlug[entry.slug] = entry`
 * in scripts/reconcile-job-slugs.mjs). A slug has up to four locale records, so
 * "which one wins" is decided purely by array position. Before the split that
 * position was whatever the previous run's append order happened to leave —
 * unstable run to run, and nothing anywhere pinned it. Sharding has to define
 * SOME order, so it defines the one that is actually correct.
 *
 * Measured on the committed ledger (29,386 records / 14,241 slugs): of the 5,003
 * slugs whose winner changes, 4,314 consume byte-identical data, and the
 * remaining 689 were being built from a locale record with ZERO impressions and
 * ZERO queries while a sibling holding the real GSC signal was discarded —
 * e.g. `case-anziani` won by an empty `en` record while the `it` record carried
 * 2,372 impressions and 20 queries. Total impressions on the winning record
 * across all slugs: 31,509 before, 52,235 after (+66%). Those 689 soft-landing
 * pages were shipping without the query content they exist to show, on URLs
 * already ranking in Search Console — silently, since an empty record is not an
 * error. Ranking by signal fixes that as a side effect of having to be
 * deterministic; `locale` breaks ties so the result is stable.
 */
function signalRank(r) {
  return [
    Number(r?.totalImpressions) || 0,
    Number(r?.totalClicks) || 0,
    Array.isArray(r?.queries) ? r.queries.length : 0,
    String(r?.locale ?? ''),
  ];
}

function compareSignalRank(a, b) {
  const ra = signalRank(a);
  const rb = signalRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

/**
 * Collapse records sharing an identity, keeping the one with the most Search
 * Console signal (ties → the later occurrence, so the result is stable).
 *
 * @param {Iterable<Record<string, unknown>>} records
 * @returns {Map<string, Record<string, unknown>>}
 */
function dedupeByIdentity(records) {
  const byKey = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object' || !r.slug) continue;
    const k = orphanRecordKey(r);
    const prev = byKey.get(k);
    if (prev && compareSignalRank(r, prev) < 0) continue;
    byKey.set(k, r);
  }
  return byKey;
}

/** On-disk order inside a shard: stable, content-independent, minimal diff. */
function compareCanonical(a, b) {
  const sa = String(a?.slug ?? '');
  const sb = String(b?.slug ?? '');
  if (sa !== sb) return sa < sb ? -1 : 1;
  const la = String(a?.locale ?? '');
  const lb = String(b?.locale ?? '');
  if (la !== lb) return la < lb ? -1 : 1;
  return 0;
}

/**
 * Read the full logical ledger as ONE array of enriched orphan records.
 *
 * Concatenates every shard's `orphans` array. If a legacy monolith is ALSO on
 * disk (a checkout that predates the split, or a stale writer that re-created
 * it) its records are merged in FIRST, so shards win on the same
 * `(slug, locale)` — lossless in both directions, and no reader can regress to
 * an empty ledger mid-transition.
 *
 * Returned order: grouped by slug, and within a slug sorted by ASCENDING search
 * signal so the strongest record is LAST. See `signalRank` — the callers all
 * resolve a slug by last-one-wins, so this is the read contract, not cosmetics.
 *
 * Never throws — a corrupt/mid-write shard is skipped, mirroring the
 * `readJsonSafe(file, [])` contract every caller relied on. Peak memory is
 * lower than the monolith it replaces: one shard's text is parsed and appended
 * before the next is read, instead of holding a 112 MB string and its parse
 * result at the same time.
 *
 * @param {string} [rootDir]
 * @returns {Array<Record<string, unknown>>}
 */
export function readOrphanEnriched(rootDir = process.cwd()) {
  // Legacy monolith first (if any) so shard records override it.
  let legacy = [];
  try {
    const j = JSON.parse(fs.readFileSync(orphanEnrichedLegacyFile(rootDir), 'utf-8'));
    if (Array.isArray(j)) legacy = j;
  } catch {
    /* absent or unparseable — the shards are the normal source */
  }

  const shardRecords = [];
  for (const f of listOrphanEnrichedShardFiles(rootDir)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      // Appended one by one, not `push(...j.orphans)`: the spread passes every
      // record as a separate argument, and this ledger is an accumulator whose
      // whole history is one oversize blob away from breaking a push again.
      if (Array.isArray(j?.orphans)) for (const r of j.orphans) shardRecords.push(r);
    } catch {
      /* skip corrupt/mid-write shard */
    }
  }

  // Shards are authoritative over a residual monolith, but a duplicate WITHIN
  // one source resolves to the richer record, never simply the later one: the
  // committed ledger carried 295 such pairs and taking the last one silently
  // dropped 310 Search Console impressions — small, but the impressions ARE the
  // reason these records exist.
  const byKey = dedupeByIdentity(legacy);
  for (const [k, v] of dedupeByIdentity(shardRecords)) byKey.set(k, v);

  // Group by slug, strongest-signal record last within each group.
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const bySlug = new Map();
  for (const r of byKey.values()) {
    const slug = String(r.slug);
    const bucket = bySlug.get(slug);
    if (bucket) bucket.push(r);
    else bySlug.set(slug, [r]);
  }

  const out = [];
  for (const slug of [...bySlug.keys()].sort()) {
    const bucket = bySlug.get(slug);
    if (bucket.length > 1) bucket.sort(compareSignalRank);
    for (const r of bucket) out.push(r);
  }
  return out;
}

/**
 * Write the full logical ledger across the shards + manifest.
 *
 * Records are distributed by `orphanEnrichedShardIndex(record.slug)` and each
 * shard is written sorted by `(slug, locale)` — a content-INDEPENDENT key, so a
 * record whose impressions changed does not move and the diff stays proportional
 * to what actually changed. Duplicate `(slug, locale)` pairs collapse to the
 * record with the most Search Console signal, matching `readOrphanEnriched`.
 *
 * The legacy monolith is removed if present — it cannot be pushed, and leaving
 * it would let a stale reader serve pre-split data.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {string} [rootDir]
 * @returns {{ totalRecords: number, totalSlugs: number, shardCount: number }}
 */
export function writeOrphanEnriched(records, rootDir = process.cwd()) {
  const src = Array.isArray(records) ? records : [];

  /** @type {Array<Array<Record<string, unknown>>>} */
  const buckets = Array.from({ length: ORPHAN_ENRICHED_SHARD_COUNT }, () => []);
  const slugs = new Set();
  for (const r of dedupeByIdentity(src).values()) {
    const slug = String(r.slug);
    slugs.add(slug);
    buckets[orphanEnrichedShardIndex(slug)].push(r);
  }

  const dir = path.resolve(rootDir, ORPHAN_ENRICHED_SHARD_DIR);
  fs.mkdirSync(dir, { recursive: true });

  let total = 0;
  for (let i = 0; i < ORPHAN_ENRICHED_SHARD_COUNT; i++) {
    const orphans = buckets[i].sort(compareCanonical);
    total += orphans.length;
    const content = `${JSON.stringify({ orphans }, null, 2)}\n`;
    const file = orphanEnrichedShardFile(i, rootDir);
    writeShardFileIfChanged(file, content);
  }

  writeFileAtomic(
    orphanEnrichedManifestFile(rootDir),
    `${JSON.stringify(
      { shardCount: ORPHAN_ENRICHED_SHARD_COUNT, totalRecords: total, totalSlugs: slugs.size },
      null,
      2,
    )}\n`,
  );

  // The monolith is unpushable (>100 MB) and now superseded — drop it.
  try {
    const legacy = orphanEnrichedLegacyFile(rootDir);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
  } catch {
    /* best-effort */
  }

  return { totalRecords: total, totalSlugs: slugs.size, shardCount: ORPHAN_ENRICHED_SHARD_COUNT };
}
