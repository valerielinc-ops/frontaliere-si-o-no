/**
 * Sharded store for the per-crawler expired archive
 * (`data/jobs/expired/by-crawler/<key>.json`).
 *
 * Why (2026-11-13): the archive is an accumulator — every retired posting of a
 * crawler is appended and nothing regenerates it — so the biggest slices grow
 * without bound. Measured on the committed blobs from 2026-11-03 to 2026-11-12:
 * coop-ticino 83.6 MB (4818 rows, ~16.9 KB/row) growing ~1.54 MiB/day, roche
 * 62.7 MB, fachkraft 43.2 MB (+1.18 MiB/day), migros-ticino 29.5 MB. The writer
 * refuses a slice past the 90 MB push-safety ceiling (assert-file-size-ceiling)
 * and GitHub refuses one past 100 MB, so coop-ticino would stop every crawler
 * and housekeeping run within a week.
 *
 * Layout. One logical archive per crawler key, stored as an ordered list of
 * plain-JSON array files in the SAME directory:
 *
 *   <key>.json              index 0 — the historical monolith (kept as is)
 *   <key>.shard-001.json    index 1
 *   <key>.shard-002.json    index 2 …
 *
 * Every file has the shape the monolith always had (a top-level array of
 * expired entries), so the logical archive is the concatenation of the files
 * in index order.
 *
 * Why flat files and not `<key>/000.json`. Each file is still a
 * `data/jobs/expired/by-crawler/*.json` path, so everything that treats the
 * directory as "a bag of expired slices" keeps working without a change and
 * without a chance to silently skip a subdirectory: the build-side readers
 * (`listSliceFileNames`, jobsSeoPagesPlugin's slice augmentation,
 * companyHubBridgePlugin), the assembler's aggregate, the per-file
 * canonicalizer and integrity guard in git-commit-data.sh, the sparse
 * checkout patterns, the `*.json` path globs, the receipt path validator and
 * the 90 MB ceiling table. Only the readers and writers that address ONE
 * crawler by `${key}.json` need this module.
 *
 * Why size shards and not monthly shards. The rows are not distributed evenly
 * in time (a backfill lands months of history at once), and the problem to
 * solve is bytes per file. A size bound states the invariant directly.
 *
 * Why rows never move between files. Assignment is membership-stable: a row
 * whose slug already lives in file i stays in file i (updated in place), and
 * only NEW rows are appended to the last file, which is closed at
 * `EXPIRED_SLICE_SHARD_TARGET_BYTES` (45 MB, half the 90 MB ceiling). So:
 *   - a shard the writer does not touch stays byte-identical (small git
 *     deltas, and the per-file 3-way merge of concurrent writers stays exact);
 *   - no file ever shrinks because a row moved to a sibling, which the
 *     per-file catastrophic-shrink guard of the commit path would refuse;
 *   - the monolith is never deleted by a pipeline writer. The isolated commit
 *     path of git-commit-data.sh skips a missing file unless it is named with
 *     --extra-only, and the explicit-delete path refuses a catastrophic slice
 *     deletion: an automatic split would have left the monolith on main next
 *     to shards holding the same rows. A crawler whose monolith is already
 *     over the target (coop-ticino) simply stops growing it.
 * Only a file that an in-place update would push over the hard ceiling spills
 * its tail rows to the open shard, so the 90 MB guard can never fire on a
 * write the store could have placed.
 *
 * `splitExpiredSliceMonolith` is the lossless offline migration of a monolith
 * into shards (same rows, same order), used by
 * `scripts/split-expired-slice-shards.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './read-large-json.mjs';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { assertByteSizeCeiling } from './assert-file-size-ceiling.mjs';
import { EXPIRED_SLICE_SIZE_LIMIT_BYTES } from './related-search-output-limit.mjs';
import {
  expiredSliceFileName,
  expiredSliceKeyOf,
  expiredSliceNamesForKey,
  parseExpiredSliceFileName,
} from './expired-slice-names.mjs';

export {
  EXPIRED_SLICE_SHARD_RE,
  expiredSliceFileName,
  expiredSliceKeyOf,
  expiredSliceNamesForKey,
  parseExpiredSliceFileName,
} from './expired-slice-names.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXPIRED_SLICES_DIR = path.resolve(__dirname, '..', '..', 'data', 'jobs', 'expired', 'by-crawler');

const MB = 1024 * 1024;

/** A shard is closed (a new one opened) when a new row would take it past this. */
export const EXPIRED_SLICE_SHARD_TARGET_BYTES = 45 * MB;

// Only an ABSENT directory is an empty archive. Any other failure (EIO,
// EACCES, ENOTDIR…) must propagate: read as `[]`, a writer would rewrite the
// crawler's archive with only the rows of the current run.
function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Existing files of `key` in `dir`: `[{ name, path, index }]` in index order. */
export function listExpiredSliceFiles(key, { dir = DEFAULT_EXPIRED_SLICES_DIR } = {}) {
  return expiredSliceNamesForKey(listNames(dir), key).map((name) => ({
    name,
    path: path.join(dir, name),
    index: parseExpiredSliceFileName(name).index,
  }));
}

/** Every crawler key that has at least one expired file in `dir`, sorted. */
export function listExpiredSliceKeys({ dir = DEFAULT_EXPIRED_SLICES_DIR } = {}) {
  const keys = new Set();
  for (const name of listNames(dir)) {
    const key = expiredSliceKeyOf(name);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The files of `key` with their rows, in index order. Reads with readJsonFile
 * (#18272: no `JSON.parse(readFileSync)` on files that can pass V8's string
 * limit). Fails closed: a file that exists but is unreadable or not an array
 * throws, because a writer that started from `[]` would rewrite it with only
 * the rows of the current run.
 */
export function readExpiredSliceShards(key, { dir = DEFAULT_EXPIRED_SLICES_DIR } = {}) {
  if (!key) return [];
  return listExpiredSliceFiles(key, { dir }).map((file) => {
    let rows;
    try {
      rows = readJsonFile(file.path);
    } catch (error) {
      throw new Error(`expired slice ${file.name} is unreadable: ${error.message}`);
    }
    if (!Array.isArray(rows)) throw new Error(`expired slice ${file.name} is not an array`);
    return { ...file, rows };
  });
}

/**
 * THE read API: every row of `key` across the monolith and its shards, in
 * index order (monolith first). Missing key → `[]`; unreadable file → throws.
 */
export function readExpiredSliceRows(key, { dir = DEFAULT_EXPIRED_SLICES_DIR } = {}) {
  const rows = [];
  for (const shard of readExpiredSliceShards(key, { dir })) {
    for (const row of shard.rows) rows.push(row);
  }
  return rows;
}

/**
 * Bytes `writeJsonAtomic(path, rows)` writes: `JSON.stringify(rows, null, 2)`
 * plus the trailing newline. Row cost is additive: the row is re-indented by
 * two spaces per line, prefixed by two spaces and followed by `,\n`/`\n`.
 */
export function expiredRowBytes(row) {
  const json = JSON.stringify(row, null, 2) ?? 'null';
  let newlines = 0;
  for (let i = json.indexOf('\n'); i !== -1; i = json.indexOf('\n', i + 1)) newlines++;
  return Buffer.byteLength(json, 'utf8') + 2 * newlines + 4;
}

const EMPTY_ARRAY_FILE_BYTES = 3; // "[]\n"

function bucketBytes(costs) {
  let total = EMPTY_ARRAY_FILE_BYTES;
  for (const cost of costs) total += cost;
  return total;
}

function rowIdentity(row) {
  return typeof row?.slug === 'string' && row.slug ? `slug:${row.slug}` : null;
}

/**
 * Persist the logical archive `rows` of `key`.
 *
 * `rows` is the complete archive in the writer's canonical order. Rows whose
 * slug already lives in a file stay there; new rows are appended to the last
 * file, opening `<key>.shard-NNN.json` whenever the target would be exceeded.
 * Files whose content did not change are not rewritten. Every file is checked
 * against the 90 MB ceiling before anything is written.
 *
 * @param {string} key
 * @param {object[]} rows
 * @param {{ dir?: string, shardTargetBytes?: number, hardCeilingBytes?: number,
 *   existing?: Array<{ index: number, rows: object[] }> }} [opts]
 *   `existing` is the result of readExpiredSliceShards when the caller already
 *   read it (avoids parsing an 80 MB archive twice). `onBeforeWrite(path)` is
 *   called before each file is (re)written — a rollback journal hook.
 * @returns {{ written: string[], files: Array<{ name: string, bytes: number, rows: number }> }}
 */
export function writeExpiredSliceRows(key, rows, opts = {}) {
  if (!key) throw new TypeError('expired slice key is required');
  if (!Array.isArray(rows)) throw new TypeError('expired slice rows must be an array');
  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  const target = opts.shardTargetBytes ?? EXPIRED_SLICE_SHARD_TARGET_BYTES;
  const hardCeiling = opts.hardCeilingBytes ?? EXPIRED_SLICE_SIZE_LIMIT_BYTES;
  const existing = opts.existing ?? readExpiredSliceShards(key, { dir });

  const owner = new Map();
  for (const shard of existing) {
    for (const row of shard.rows) {
      const id = rowIdentity(row);
      if (id && !owner.has(id)) owner.set(id, shard.index);
    }
  }

  // Decide WHICH file each row goes to first; the content of every file is
  // then built in the caller's order (canonical expiredAt-desc), so a file
  // that receives new rows stays sorted exactly like the monolith was.
  const assigned = new Map(); // row -> index
  const costOf = new Map(); // row -> bytes
  const bytesByIndex = new Map();
  const countByIndex = new Map();
  const addTo = (row, index) => {
    assigned.set(row, index);
    bytesByIndex.set(index, (bytesByIndex.get(index) ?? EMPTY_ARRAY_FILE_BYTES) + costOf.get(row));
    countByIndex.set(index, (countByIndex.get(index) ?? 0) + 1);
  };
  for (const shard of existing) {
    bytesByIndex.set(shard.index, EMPTY_ARRAY_FILE_BYTES);
    countByIndex.set(shard.index, 0);
  }
  const fresh = [];
  const ownedByIndex = new Map();
  for (const row of rows) {
    costOf.set(row, expiredRowBytes(row));
    const id = rowIdentity(row);
    const index = id ? owner.get(id) : undefined;
    if (index === undefined) fresh.push(row);
    else {
      addTo(row, index);
      if (!ownedByIndex.has(index)) ownedByIndex.set(index, []);
      ownedByIndex.get(index).push(row);
    }
  }

  // An in-place update can grow a file. Spill its tail to the open shard
  // rather than let the hard ceiling refuse a write the store can place.
  // The spilled rows are re-placed in canonical FILE order (lower index
  // first, each file's tail in its own order), never reversed.
  const spilled = [];
  for (const index of [...ownedByIndex.keys()].sort((a, b) => a - b)) {
    const owned = ownedByIndex.get(index);
    const tail = [];
    while (bytesByIndex.get(index) > hardCeiling && countByIndex.get(index) > 1) {
      const row = owned.pop();
      bytesByIndex.set(index, bytesByIndex.get(index) - costOf.get(row));
      countByIndex.set(index, countByIndex.get(index) - 1);
      assigned.delete(row);
      tail.unshift(row);
    }
    spilled.push(...tail);
  }

  let open = existing.length > 0 ? Math.max(...existing.map((shard) => shard.index)) : 0;
  for (const row of [...spilled, ...fresh]) {
    const openBytes = bytesByIndex.get(open) ?? EMPTY_ARRAY_FILE_BYTES;
    if (openBytes + costOf.get(row) > target && (countByIndex.get(open) ?? 0) > 0) open++;
    addTo(row, open);
  }

  const buckets = new Map();
  for (const shard of existing) buckets.set(shard.index, { rows: [], costs: [] });
  for (const row of rows) {
    const index = assigned.get(row);
    if (!buckets.has(index)) buckets.set(index, { rows: [], costs: [] });
    buckets.get(index).rows.push(row);
    buckets.get(index).costs.push(costOf.get(row));
  }

  const previousByIndex = new Map(existing.map((shard) => [shard.index, shard]));
  const plan = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([index, bucket]) => {
    const name = expiredSliceFileName(key, index);
    return {
      index,
      name,
      path: path.join(dir, name),
      rows: bucket.rows,
      bytes: bucketBytes(bucket.costs),
      existed: previousByIndex.has(index),
    };
  });
  // A brand-new empty shard is never created (only an existing file may be
  // emptied, which keeps it on disk as `[]` instead of deleting it).
  const effective = plan.filter((file) => file.existed || file.rows.length > 0);

  for (const file of effective) assertByteSizeCeiling(file.path, file.bytes, hardCeiling);

  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const file of effective) {
    // Compare bytes, not row objects: callers mutate the rows they read
    // (expiredAt repair, source-identity merge) before handing them back.
    if (file.existed && unchangedOnDisk(file.path, file.rows)) continue;
    opts.onBeforeWrite?.(file.path);
    writeJsonAtomic(file.path, file.rows);
    written.push(file.name);
  }
  return {
    written,
    files: effective.map(({ name, bytes, rows: fileRows }) => ({ name, bytes, rows: fileRows.length })),
  };
}

function unchangedOnDisk(filePath, rows) {
  try {
    const onDisk = fs.readFileSync(filePath);
    const next = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    return onDisk.length === next.length && onDisk.equals(next);
  } catch {
    return false;
  }
}

/**
 * Lossless offline migration: split the monolith `<key>.json` into
 * `<key>.shard-001.json`… (contiguous chunks, same order, each within the
 * target) and remove the monolith. Reading the key before and after returns
 * the same rows in the same order. Refuses to run when shards already exist.
 *
 * @returns {{ rows: number, files: Array<{ name: string, bytes: number, rows: number }> }}
 */
export function splitExpiredSliceMonolith(key, opts = {}) {
  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  const target = opts.shardTargetBytes ?? EXPIRED_SLICE_SHARD_TARGET_BYTES;
  const hardCeiling = opts.hardCeilingBytes ?? EXPIRED_SLICE_SIZE_LIMIT_BYTES;
  const shards = readExpiredSliceShards(key, { dir });
  if (shards.length === 0) return { rows: 0, files: [] };
  if (shards.some((shard) => shard.index !== 0)) {
    throw new Error(`${key}: shards already exist; split only a monolith`);
  }
  const rows = shards[0].rows;
  const chunks = [];
  let current = { rows: [], costs: [] };
  for (const row of rows) {
    const cost = expiredRowBytes(row);
    if (current.rows.length > 0 && bucketBytes(current.costs) + cost > target) {
      chunks.push(current);
      current = { rows: [], costs: [] };
    }
    current.rows.push(row);
    current.costs.push(cost);
  }
  if (current.rows.length > 0) chunks.push(current);

  const files = chunks.map((chunk, i) => {
    const name = expiredSliceFileName(key, i + 1);
    return { name, path: path.join(dir, name), rows: chunk.rows, bytes: bucketBytes(chunk.costs) };
  });
  for (const file of files) assertByteSizeCeiling(file.path, file.bytes, hardCeiling);
  if (opts.apply !== false) commitSplit(shards[0].path, files, opts.onStep);
  return {
    rows: rows.length,
    files: files.map(({ name, bytes, rows: fileRows }) => ({ name, bytes, rows: fileRows.length })),
  };
}

/**
 * Replace the monolith with `files` so that no reader ever sees the monolith
 * next to (partial) shards, which would duplicate rows:
 *   1. every shard is written to `<name>.split-tmp` (not a slice name, so no
 *      reader lists it);
 *   2. the monolith is renamed to `<key>.json.split-backup` (not a slice name);
 *   3. the staged shards are renamed into place;
 *   4. the backup is removed.
 * Any error rolls back to the original state: staged and committed shards are
 * removed and the monolith is restored. `onStep(step, name)` is a test seam.
 */
function commitSplit(monolithPath, files, onStep) {
  const backupPath = `${monolithPath}.split-backup`;
  const staged = [];
  const committed = [];
  let monolithMoved = false;
  try {
    for (const file of files) {
      const tmpPath = `${file.path}.split-tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(file.rows, null, 2)}\n`);
      staged.push({ tmpPath, finalPath: file.path });
      onStep?.('staged', file.name);
    }
    fs.renameSync(monolithPath, backupPath);
    monolithMoved = true;
    onStep?.('monolith-moved', path.basename(monolithPath));
    for (const { tmpPath, finalPath } of staged) {
      fs.renameSync(tmpPath, finalPath);
      committed.push(finalPath);
      onStep?.('committed', path.basename(finalPath));
    }
  } catch (error) {
    for (const finalPath of committed) fs.rmSync(finalPath, { force: true });
    for (const { tmpPath } of staged) fs.rmSync(tmpPath, { force: true });
    if (monolithMoved) fs.renameSync(backupPath, monolithPath);
    throw error;
  }
  fs.rmSync(backupPath, { force: true });
}

/** Remove every file of `key` (monolith and shards). Returns the removed names. */
export function deleteExpiredSlice(key, { dir = DEFAULT_EXPIRED_SLICES_DIR, onBeforeDelete } = {}) {
  const removed = [];
  for (const file of listExpiredSliceFiles(key, { dir })) {
    onBeforeDelete?.(file.path);
    fs.rmSync(file.path);
    removed.push(file.name);
  }
  return removed;
}
