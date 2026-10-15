/**
 * Worker for parallel JSON parsing of per-crawler job slices.
 *
 * Used by `scripts/assemble-jobs-dataset.mjs` to overlap the readFile +
 * JSON.parse cost of the 178 slices in `data/jobs/by-crawler/*.json` across
 * available CPU cores. The assembler's downstream dedup/merge logic stays
 * single-threaded on the main thread; only the read+parse phase is parallel.
 *
 * Contract:
 *   workerData = { paths: string[] }
 *     - `paths` is the round-robin chunk of absolute slice paths assigned
 *       to this worker. Order within the chunk is preserved.
 *
 *   postMessage({ results: Array<{ path: string; parsed: unknown | null; error?: string }> })
 *     - One entry per input path, in the same order as `paths`.
 *     - `parsed` is the JSON.parse result, or `null` if read/parse failed.
 *       The main thread treats `null` the same as the legacy `readJson(..., null)`
 *       fallback path (warn + skip), preserving original error behavior.
 *     - `error` carries the failure message for diagnostics; the main thread
 *       does not throw on it (mirrors the original try/catch-and-skip).
 *
 * Byte-identical guarantee:
 *   The worker performs a pure `fs.readFileSync(p, 'utf8') → JSON.parse(text)`
 *   on each path. The main thread re-assembles results in the original
 *   alphabetical input order before iterating, so dedup ordering is unchanged.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('[parse-job-slices-worker] must be spawned via worker_threads');
}

const { paths } = workerData;

const results = [];
for (const p of paths) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    results.push({ path: p, parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ path: p, parsed: null, error: msg });
  }
}

parentPort.postMessage({ results });
