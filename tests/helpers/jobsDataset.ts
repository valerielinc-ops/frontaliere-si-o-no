/**
 * `data/jobs.json`, parsed at most once per test file.
 *
 * WHY THIS EXISTS (issue #5447)
 * ─────────────────────────────
 * The dataset is a CI-assembled fixture — hundreds of MB and tens of thousands
 * of jobs once the national crawlers are folded in — and it cannot change while
 * a test file runs. Two `tests/seo/` files nevertheless re-read and re-parsed it
 * inside every `it()`.
 *
 * The cost is not the lookup: a `find()` over the array is sub-millisecond.
 * It is `readFileSync(…, 'utf8')` decoding a several-hundred-MB string plus
 * `JSON.parse`, seconds per call — and worse on the calls that must reclaim the
 * previous multi-GB object graph while allocating the next one. On the
 * post-deploy runner `gate:seo-source` runs concurrently with three other
 * validators on 4 vCPU, which is what turned "slow" into "past vitest's 15s
 * per-test timeout", failing the gate and blocking publish.
 *
 * The right fix is to stop doing the redundant work, NOT to raise the timeout:
 * a longer bound would hide the next regression in the code actually under
 * test. The 15s limit stays where it is.
 *
 * The memo is per module registry, i.e. per test file — vitest isolates file
 * module graphs, so nothing leaks between files.
 *
 * Keyed by path, and the caller passes it: every call site already derives the
 * path from its own `__dirname`, and that is the form demonstrably working
 * under both vitest projects (`dom` and `node`).
 */
import { existsSync, readFileSync } from 'node:fs';

const cache = new Map<string, unknown[] | null>();

/**
 * The parsed dataset, or `null` when the fixture is absent — a plain checkout
 * has no `data/jobs.json`, so callers offline-skip on `null` exactly as they
 * did when they read the file themselves.
 *
 * Callers name the subset of the job shape they actually read; this module is
 * deliberately shape-agnostic, since each guard cares about different fields.
 */
export function readJobsDataset<T>(jobsPath: string): T[] | null {
  if (!cache.has(jobsPath)) {
    cache.set(
      jobsPath,
      existsSync(jobsPath) ? (JSON.parse(readFileSync(jobsPath, 'utf8')) as unknown[]) : null,
    );
  }
  return cache.get(jobsPath) as T[] | null;
}
