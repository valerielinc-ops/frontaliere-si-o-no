/**
 * postWalkCoordinatorProfiler — per-category instrumentation for
 * postWalkCoordinatorPlugin. Mirrors the format of jobsSeoProfiler /
 * relatedSearchClustersProfiler so the workflow summary parser can apply
 * the same grep/sed pipeline (marker prefix `[post-walk-profile]`).
 *
 * Activated by default with build profiling. Set `POST_WALK_PROFILE=0` or
 * `BUILD_PROFILE=0` to opt out, or `POST_WALK_PROFILE=1` to force this table
 * on in a one-off local/profile run.
 *
 * Categories the coordinator + worker emit:
 *   Coordinator (closeBundle main thread):
 *     - walk-dist            → recursive walk of dist/ to enumerate HTML
 *     - load-blog-articles   → readBlogIndexSlugs + listBlogArticleHtmlFiles
 *     - chunk-roundrobin     → split processHtmlPaths into worker chunks
 *     - worker-dispatch      → Promise.all over workers
 *     - merge-results        → fold per-worker result objects
 *   Worker (postWalkWorker.mjs per-file phases):
 *     - read                 → fs.promises.readFile of the source HTML
 *     - bridge-check         → cheap pre-emitted-bridge prefix discriminator
 *     - bridge-transform     → transformFlatRedirect (sibling read + render)
 *     - blog-inject          → injectContextualLinks on blog index files
 *     - hreflang-transform   → transformHreflang (strip broken hreflang)
 *     - write                → fs.promises.writeFile when mutated
 *
 * Worker merge model: each Worker thread instantiates its own module copy
 * (per-process state, identical to how `jobs-seo-profile` works during the
 * canonical-fallback pre-pass). The worker exports `dumpBuckets()` which the
 * coordinator postMessages back; the coordinator merges samples with
 * `ingestBuckets()` and calls `printSummary()` once at the end. Reservoir
 * sampling is preserved on merge (per-category cap = SAMPLE_CAP).
 *
 * Output format (sorted by totalMs DESC) — IDENTICAL columns to jobs-seo:
 *
 *   [post-walk-profile] category                  count    total_ms   %  avg_ms  p50_ms  p99_ms  min_ms  max_ms
 *   [post-walk-profile] hreflang-transform        118432   65003.8    36   0.55    0.49    1.22    0.10    14.5
 *   [post-walk-profile] read                      118432   42100.1    23   0.36    0.31    0.92    0.04     9.8
 *   ...
 */

const ENABLED = process.env.POST_WALK_PROFILE === '1'
  || (process.env.POST_WALK_PROFILE !== '0' && process.env.BUILD_PROFILE !== '0');

type CategoryStats = {
  count: number;
  totalNs: bigint;
  minNs: bigint;
  maxNs: bigint;
  // Reservoir of sample durations in ns for percentile estimation. We keep
  // up to 10k samples per category (random replacement) to bound memory.
  samplesNs: number[];
};

const buckets = new Map<string, CategoryStats>();
const SAMPLE_CAP = 10_000;

/**
 * Returns a token usable with recordEmit(). Caller should bracket exactly the
 * work that produces the next emit and pass the token back. When the
 * profiler is disabled, returns 0n and recordEmit is a no-op.
 */
export function startTimer(): bigint {
  if (!ENABLED) return 0n;
  return process.hrtime.bigint();
}

/**
 * Record one emit in the named category. `start` MUST be the value returned
 * by a paired `startTimer()` call. Safe to call when disabled (no-op).
 */
export function recordEmit(category: string, start: bigint): void {
  if (!ENABLED || start === 0n) return;
  const elapsed = process.hrtime.bigint() - start;
  let b = buckets.get(category);
  if (!b) {
    b = {
      count: 0,
      totalNs: 0n,
      minNs: elapsed,
      maxNs: elapsed,
      samplesNs: [],
    };
    buckets.set(category, b);
  }
  b.count++;
  b.totalNs += elapsed;
  if (elapsed < b.minNs) b.minNs = elapsed;
  if (elapsed > b.maxNs) b.maxNs = elapsed;
  const elapsedNum = Number(elapsed);
  if (b.samplesNs.length < SAMPLE_CAP) {
    b.samplesNs.push(elapsedNum);
  } else {
    const idx = Math.floor(Math.random() * b.count);
    if (idx < SAMPLE_CAP) b.samplesNs[idx] = elapsedNum;
  }
}

/** Convenience helper: time a synchronous closure and record the result. */
export function timed<T>(category: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const t = startTimer();
  try {
    return fn();
  } finally {
    recordEmit(category, t);
  }
}

/**
 * Serializable snapshot of this process' buckets. Designed to cross
 * `parentPort.postMessage` cheaply — `bigint` is converted to `string` for
 * structured-clone compatibility (workerData is fine with bigint but
 * postMessage to the main thread is not in all Node versions; use string
 * for safety).
 */
export type SerializedBuckets = Array<{
  category: string;
  count: number;
  totalNs: string;
  minNs: string;
  maxNs: string;
  samplesNs: number[];
}>;

export function dumpBuckets(): SerializedBuckets {
  const out: SerializedBuckets = [];
  for (const [category, b] of buckets) {
    out.push({
      category,
      count: b.count,
      totalNs: b.totalNs.toString(),
      minNs: b.minNs.toString(),
      maxNs: b.maxNs.toString(),
      samplesNs: b.samplesNs,
    });
  }
  return out;
}

/**
 * Merge a serialized snapshot (from a worker thread) into this process'
 * buckets. Reservoir cap is re-applied after merge so the final sample set
 * stays bounded regardless of worker count.
 */
export function ingestBuckets(snap: SerializedBuckets): void {
  if (!ENABLED) return;
  for (const entry of snap) {
    let b = buckets.get(entry.category);
    const entryTotalNs = BigInt(entry.totalNs);
    const entryMinNs = BigInt(entry.minNs);
    const entryMaxNs = BigInt(entry.maxNs);
    if (!b) {
      b = {
        count: entry.count,
        totalNs: entryTotalNs,
        minNs: entryMinNs,
        maxNs: entryMaxNs,
        samplesNs: entry.samplesNs.slice(),
      };
      buckets.set(entry.category, b);
    } else {
      b.count += entry.count;
      b.totalNs += entryTotalNs;
      if (entryMinNs < b.minNs) b.minNs = entryMinNs;
      if (entryMaxNs > b.maxNs) b.maxNs = entryMaxNs;
      b.samplesNs.push(...entry.samplesNs);
    }
    if (b.samplesNs.length > SAMPLE_CAP) {
      // Down-sample uniformly to the cap so percentiles stay representative.
      const step = b.samplesNs.length / SAMPLE_CAP;
      const reduced: number[] = new Array(SAMPLE_CAP);
      for (let i = 0; i < SAMPLE_CAP; i++) {
        reduced[i] = b.samplesNs[Math.floor(i * step)];
      }
      b.samplesNs = reduced;
    }
  }
}

function nsToMs(ns: bigint | number): number {
  const n = typeof ns === 'bigint' ? Number(ns) : ns;
  return n / 1_000_000;
}

function percentile(sortedSamplesMs: number[], p: number): number {
  if (sortedSamplesMs.length === 0) return 0;
  const idx = Math.min(
    sortedSamplesMs.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedSamplesMs.length)),
  );
  return sortedSamplesMs[idx];
}

/**
 * Print a sorted summary table to stdout. No-op when the profiler is
 * disabled. Each row is prefixed with `[post-walk-profile]` so the
 * workflow summary step can grep+sed it identically to jobs-seo / related.
 */
export function printSummary(): void {
  if (!ENABLED) return;
  const rows = Array.from(buckets.entries()).map(([category, b]) => {
    const sorted = b.samplesNs.slice().sort((a, b) => a - b);
    const sortedMs = sorted.map((n) => n / 1_000_000);
    return {
      category,
      count: b.count,
      totalMs: nsToMs(b.totalNs),
      avgMs: nsToMs(b.totalNs) / b.count,
      p50Ms: percentile(sortedMs, 50),
      p99Ms: percentile(sortedMs, 99),
      minMs: nsToMs(b.minNs),
      maxMs: nsToMs(b.maxNs),
    };
  });
  rows.sort((a, b) => b.totalMs - a.totalMs);

  const totalMsAll = rows.reduce((s, r) => s + r.totalMs, 0);
  const totalCountAll = rows.reduce((s, r) => s + r.count, 0);

  // eslint-disable-next-line no-console
  console.log(
    `[post-walk-profile] ${'category'.padEnd(28)} ${'count'.padStart(7)} ${'total_ms'.padStart(10)} ${'%'.padStart(5)} ${'avg_ms'.padStart(8)} ${'p50_ms'.padStart(8)} ${'p99_ms'.padStart(8)} ${'min_ms'.padStart(7)} ${'max_ms'.padStart(8)}`,
  );
  for (const r of rows) {
    const pct = totalMsAll > 0 ? (r.totalMs / totalMsAll) * 100 : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[post-walk-profile] ${r.category.padEnd(28)} ${String(r.count).padStart(7)} ${r.totalMs.toFixed(1).padStart(10)} ${pct.toFixed(1).padStart(5)} ${r.avgMs.toFixed(2).padStart(8)} ${r.p50Ms.toFixed(2).padStart(8)} ${r.p99Ms.toFixed(2).padStart(8)} ${r.minMs.toFixed(2).padStart(7)} ${r.maxMs.toFixed(2).padStart(8)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[post-walk-profile] ${'TOTAL'.padEnd(28)} ${String(totalCountAll).padStart(7)} ${totalMsAll.toFixed(1).padStart(10)}`,
  );
}

/** Reset all collected stats. Mainly useful for tests. */
export function resetProfiler(): void {
  buckets.clear();
}

/** True if the profiler is active for this process. */
export function isEnabled(): boolean {
  return ENABLED;
}
