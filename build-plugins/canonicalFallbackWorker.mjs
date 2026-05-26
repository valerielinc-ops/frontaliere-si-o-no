/**
 * Worker for jobsSeoPagesPlugin's canonical-fallback pre-compute pass
 * (perf optimization 2026-05-26, after run 26440498634 showed
 * ph:canonical-fallback dominated active-job per-page render at 91 %).
 *
 * Receives a chunk of {key, description, requirements} tuples, runs
 * `canonicalizeFallbackCleaned` on each, and returns a flat array of
 * {key, cleaned} pairs. The coordinator (jobsSeoPagesPlugin closeBundle)
 * merges all worker outputs into `canonicalCleanedCache` BEFORE the main
 * per-locale emit loop, so the locale loop's calls become 100 %
 * cache-hit (and the parse + 12 cleanCanonicalItems runs once per unique
 * tuple instead of once per locale-loop iteration).
 *
 * Why a worker: `canonicalizeFallbackCleaned` is pure JS (regex + string
 * passes, no I/O) and runs ~22 ms × 23k pages serial = 500+ s of pure
 * CPU on the single-threaded closeBundle. The 4-worker pool (GH Actions
 * 4 vCPU runner) lets us reclaim ~75 % of that wall-clock by running
 * the parses in parallel across cores.
 *
 * tsx loader: this file is plain ESM JS (.mjs) so Node can boot it
 * without a TS loader at the entry point. The coordinator spawns the
 * worker with `execArgv: ['--import', 'tsx']` so the dynamic import of
 * the `.ts` canonicalFallback implementation resolves correctly.
 *
 * Byte-identical output: `canonicalizeFallbackCleaned` is a pure function
 * — same (description, requirements) → same CleanedFallbackContent every
 * call, regardless of which thread runs it. The merge step on the main
 * thread populates the cache by key so write ordering doesn't matter.
 */
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('[canonicalFallbackWorker] must be spawned via worker_threads');
}

const { canonicalizeFallbackCleaned } = await import('../services/jobs/canonicalFallback.ts');

const { tuples } = /** @type {{ tuples: Array<{ key: string, description: string, requirements: string[] }> }} */ (
  workerData
);

/** @type {Array<{ key: string, cleaned: import('../services/jobs/canonicalFallback.ts').CleanedFallbackContent }>} */
const out = new Array(tuples.length);
for (let i = 0; i < tuples.length; i++) {
  const t = tuples[i];
  out[i] = { key: t.key, cleaned: canonicalizeFallbackCleaned(t.description, t.requirements) };
}

parentPort.postMessage({ entries: out });
