/**
 * jobs-loader.mjs — Shared loader for per-canton job shards.
 *
 * Decision E4: monolithic `data/jobs.json` is DEPRECATED. All consumers
 * (build-plugins, SPA hydration, scripts) MUST read from per-canton shards
 * via this module.
 *
 * Data flow:
 *
 *   data/jobs-by-canton/
 *     ├── TI.json        ─┐
 *     ├── ZH.json         │
 *     ├── GE.json         │      ┌──────────────────────┐
 *     ├── ...             ├────▶ │   jobs-loader.mjs    │ ──▶ build-plugins
 *     ├── VS.json         │      │  - loadCantonJobs    │ ──▶ assemble-jobs
 *     ├── _AGGREGATE_.json│      │  - loadAllJobs       │ ──▶ SPA shell
 *     └── ...             ─┘      │  - streamAllJobs    │ ──▶ aggregator pages
 *                                 │  - loadAggregateJobs│
 *                                 │  - writeCantonJobs  │
 *                                 └──────────────────────┘
 *
 * The `_AGGREGATE_` special key holds jobs without a confirmed canton
 * (remote, uncertain location, etc.).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root: scripts/lib → ../../
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SHARD_DIR = path.join(PROJECT_ROOT, 'data', 'jobs-by-canton');

/** Special canton key for jobs without a confirmed canton. */
export const AGGREGATE_KEY = '_AGGREGATE_';

/** Per-canton in-memory cache (cantonCode → Job[]). */
const _cache = new Map();

/** One-shot warning guard for missing shard directory. */
let _missingDirWarned = false;

/**
 * Whether a value is a non-empty string.
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a job record has the minimum required fields.
 * Logs a warning per offending job; does not throw.
 *
 * @param {unknown} job
 * @param {string} cantonCode
 * @param {number} index
 * @returns {boolean} true if the job has the required fields
 */
function validateJob(job, cantonCode, index) {
  if (!job || typeof job !== 'object') {
    console.warn(
      `[jobs-loader] ${cantonCode}[${index}] is not an object, skipping`,
    );
    return false;
  }
  const j = /** @type {Record<string, unknown>} */ (job);
  const missing = [];
  if (!isNonEmptyString(j.slug)) missing.push('slug');
  if (!isNonEmptyString(j.title)) missing.push('title');
  if (!isNonEmptyString(j.company)) missing.push('company');
  // canton can be the string AGGREGATE_KEY for the aggregate shard.
  if (!isNonEmptyString(j.canton)) missing.push('canton');
  if (missing.length > 0) {
    console.warn(
      `[jobs-loader] ${cantonCode}[${index}] (slug=${String(j.slug)}) ` +
        `missing required fields: ${missing.join(', ')}`,
    );
    return false;
  }
  return true;
}

/**
 * Check whether the shard directory exists. Logs a single warning if not.
 * @returns {Promise<boolean>}
 */
async function shardDirExists() {
  try {
    const stat = await fs.stat(SHARD_DIR);
    return stat.isDirectory();
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      if (!_missingDirWarned) {
        _missingDirWarned = true;
        console.warn(
          `[jobs-loader] shard directory missing: ${SHARD_DIR}. ` +
            `Returning empty results until assemble-jobs has run.`,
        );
      }
      return false;
    }
    throw err;
  }
}

/**
 * Returns the absolute path to a per-canton shard file.
 *
 * @param {string} cantonCode 2-letter canton code (e.g. "TI", "ZH") or `_AGGREGATE_`.
 * @returns {string}
 */
export function getCantonShardPath(cantonCode) {
  if (!isNonEmptyString(cantonCode)) {
    throw new TypeError('getCantonShardPath: cantonCode must be a non-empty string');
  }
  return path.join(SHARD_DIR, `${cantonCode}.json`);
}

/**
 * Clear the per-canton in-memory cache. Useful for tests or long-running
 * scripts that need fresh data after a write.
 *
 * @returns {void}
 */
export function clearCache() {
  _cache.clear();
}

/**
 * Read and parse a single shard file. Returns [] if the file is missing.
 *
 * @param {string} cantonCode
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readShard(cantonCode) {
  const filePath = getCantonShardPath(cantonCode);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[jobs-loader] failed to parse ${filePath}: ${
        /** @type {Error} */ (err).message
      }`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `[jobs-loader] ${filePath} is not an array (got ${typeof parsed}); ignoring`,
    );
    return [];
  }
  return parsed;
}

/**
 * Load all jobs for a single canton (cached).
 *
 * @param {string} cantonCode 2-letter canton code or `_AGGREGATE_`.
 * @returns {Promise<Array<Record<string, unknown>>>} Empty array if file missing.
 */
export async function loadCantonJobs(cantonCode) {
  if (!isNonEmptyString(cantonCode)) {
    throw new TypeError('loadCantonJobs: cantonCode must be a non-empty string');
  }
  if (_cache.has(cantonCode)) {
    return _cache.get(cantonCode);
  }
  const rows = await readShard(cantonCode);
  const valid = rows.filter((job, i) => validateJob(job, cantonCode, i));
  _cache.set(cantonCode, valid);
  return valid;
}

/**
 * List all per-canton shard codes present on disk (without `.json`).
 * Returns [] if the shard directory is missing.
 *
 * @returns {Promise<string[]>}
 */
async function listShardCodes() {
  if (!(await shardDirExists())) return [];
  const entries = await fs.readdir(SHARD_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Load EVERY job across all per-canton shards into a single array.
 * Reads one file at a time (no Promise.all) to avoid 26-way parallel I/O.
 *
 * NOTE: at scale (50k jobs × ~5KB each) this materializes ~250MB. For
 * build-plugin use prefer `streamAllJobs()` or `loadAggregateJobs(filterFn)`.
 *
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function loadAllJobs() {
  const codes = await listShardCodes();
  /** @type {Array<Record<string, unknown>>} */
  const merged = [];
  for (const code of codes) {
    const jobs = await loadCantonJobs(code);
    for (const job of jobs) merged.push(job);
  }
  return merged;
}

/**
 * Async generator that yields every job across all shards, one at a time.
 * Reads a single shard, yields each job, then drops the shard reference
 * before reading the next. Memory footprint is ~one shard at a time.
 *
 * If `data/jobs-by-canton/` does not exist, the generator yields nothing
 * (and a single warning is logged via `shardDirExists()`).
 *
 * @returns {AsyncGenerator<Record<string, unknown>, void, void>}
 */
export async function* streamAllJobs() {
  const codes = await listShardCodes();
  for (const code of codes) {
    // Bypass cache to avoid retaining every shard in memory during a stream.
    const rows = await readShard(code);
    for (let i = 0; i < rows.length; i += 1) {
      const job = rows[i];
      if (validateJob(job, code, i)) {
        yield job;
      }
    }
  }
}

/**
 * Stream-filter all jobs through a predicate and return the matches.
 * Useful for aggregator pages that need a small subset of the corpus
 * without materializing every shard.
 *
 * @param {(job: Record<string, unknown>) => boolean} filterFn
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function loadAggregateJobs(filterFn) {
  if (typeof filterFn !== 'function') {
    throw new TypeError('loadAggregateJobs: filterFn must be a function');
  }
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for await (const job of streamAllJobs()) {
    if (filterFn(job)) out.push(job);
  }
  return out;
}

/**
 * Atomically write a per-canton shard. Writes to a temp file in the same
 * directory, then renames over the destination. Invalidates the cache
 * entry for the written canton.
 *
 * @param {string} cantonCode 2-letter canton code or `_AGGREGATE_`.
 * @param {Array<Record<string, unknown>>} jobs
 * @returns {Promise<void>}
 */
export async function writeCantonJobs(cantonCode, jobs) {
  if (!isNonEmptyString(cantonCode)) {
    throw new TypeError('writeCantonJobs: cantonCode must be a non-empty string');
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError('writeCantonJobs: jobs must be an array');
  }
  await fs.mkdir(SHARD_DIR, { recursive: true });
  const finalPath = getCantonShardPath(cantonCode);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(jobs, null, 2)}\n`;
  await fs.writeFile(tmpPath, payload, 'utf8');
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of temp file on rename failure.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  _cache.delete(cantonCode);
}
