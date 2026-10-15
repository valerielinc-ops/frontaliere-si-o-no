/**
 * relatedSearchClustersProfiler — per-phase instrumentation for
 * relatedSearchClustersPlugin.
 *
 * Activated by default with build profiling. Set
 * `RELATED_SEARCH_CLUSTERS_PROFILE=0` or `BUILD_PROFILE=0` to opt out.
 */

const ENABLED = process.env.RELATED_SEARCH_CLUSTERS_PROFILE === '1'
  || (process.env.RELATED_SEARCH_CLUSTERS_PROFILE !== '0' && process.env.BUILD_PROFILE !== '0');

type CategoryStats = {
  count: number;
  totalNs: bigint;
  minNs: bigint;
  maxNs: bigint;
  samplesNs: number[];
};

const buckets = new Map<string, CategoryStats>();
const SAMPLE_CAP = 10_000;

export function startTimer(): bigint {
  if (!ENABLED) return 0n;
  return process.hrtime.bigint();
}

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

  console.log(
    `[related-search-profile] ${'category'.padEnd(28)} ${'count'.padStart(7)} ${'total_ms'.padStart(10)} ${'%'.padStart(5)} ${'avg_ms'.padStart(8)} ${'p50_ms'.padStart(8)} ${'p99_ms'.padStart(8)} ${'min_ms'.padStart(7)} ${'max_ms'.padStart(8)}`,
  );
  for (const r of rows) {
    const pct = totalMsAll > 0 ? (r.totalMs / totalMsAll) * 100 : 0;
    console.log(
      `[related-search-profile] ${r.category.padEnd(28)} ${String(r.count).padStart(7)} ${r.totalMs.toFixed(1).padStart(10)} ${pct.toFixed(1).padStart(5)} ${r.avgMs.toFixed(2).padStart(8)} ${r.p50Ms.toFixed(2).padStart(8)} ${r.p99Ms.toFixed(2).padStart(8)} ${r.minMs.toFixed(2).padStart(7)} ${r.maxMs.toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    `[related-search-profile] ${'TOTAL'.padEnd(28)} ${String(totalCountAll).padStart(7)} ${totalMsAll.toFixed(1).padStart(10)}`,
  );
}

export function resetProfiler(): void {
  buckets.clear();
}

export function isEnabled(): boolean {
  return ENABLED;
}
