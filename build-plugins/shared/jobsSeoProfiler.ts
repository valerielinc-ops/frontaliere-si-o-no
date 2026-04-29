/**
 * jobsSeoProfiler — per-category instrumentation for jobsSeoPagesPlugin.
 *
 * Activated only when `JOBS_SEO_PROFILE=1`. When disabled, every entry point
 * is a no-op so production builds carry zero measurable overhead (the env
 * check is read once at module load).
 *
 * Categories the plugin emits:
 *   - active-job                 → /cerca-lavoro-{loc}/<slug>/index.html
 *   - active-job-flat            → /cerca-lavoro-{loc}/<slug>.html
 *   - active-job-legacy          → soft redirect for non-IT locales whose
 *                                  localized slug differs from the IT slug
 *   - company-landing            → /cerca-lavoro-{loc}/employer-<slug>/
 *   - brand-bridge               → BRAND_CANONICAL_MAP alias bridges
 *   - editorial-jobs-today       → /lavori-oggi-<city>/ and friends
 *   - editorial-location-hub     → location-specific editorial landings
 *   - global-part-time           → /lavoro-part-time/ hub × 4 locales
 *   - paginated-listing          → /cerca-lavoro-{loc}/pagina-N/
 *   - category-listing           → /cerca-lavoro-{loc}/categoria-<sector>/
 *   - gsc-keyword-landing        → keyword-pages-config.json driven
 *   - search-stats-landing       → top locations + titles from jobs-stats.json
 *   - search-combo-landing       → location × title combinations
 *   - expired-soft-landing       → soft-landing pages for expired job slugs
 *   - expired-legacy-bridge      → legacy slug bridges for expired jobs
 *   - previous-slug-bridge       → full-content bridge at old slug, canonical
 *                                  points to current slug
 *   - cross-locale-reconciliation → bridge at <foreignSlug> under base locale
 *   - self-healing-tracking      → safety-net redirects for tracking paths
 *
 * Usage at the plugin call site:
 *
 *   import { startTimer, recordEmit, printSummary } from './shared/jobsSeoProfiler';
 *
 *   const t = startTimer();
 *   // ... do the work that produces ONE file ...
 *   _qw(filePath, html);
 *   recordEmit('active-job', t);
 *
 *   // ... at end of closeBundle:
 *   printSummary();
 *
 * Output format (sorted by totalMs DESC):
 *
 *   [jobs-seo-profile] category                  count    total_ms   avg_ms     p50      p99    min    max
 *   [jobs-seo-profile] active-job                  9192   307521.4    33.46    32.10   78.20   12.4   240.5
 *   [jobs-seo-profile] expired-soft-landing       58856    65003.8     1.10     0.95    3.40    0.6    18.2
 *   ...
 */

const ENABLED = process.env.JOBS_SEO_PROFILE === '1';

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
  // Reservoir sampling — keep distribution shape without unbounded memory.
  const elapsedNum = Number(elapsed);
  if (b.samplesNs.length < SAMPLE_CAP) {
    b.samplesNs.push(elapsedNum);
  } else {
    const idx = Math.floor(Math.random() * b.count);
    if (idx < SAMPLE_CAP) b.samplesNs[idx] = elapsedNum;
  }
}

/**
 * Convenience helper: time a synchronous closure and record the result.
 * Useful when the work is a single expression. For multi-statement blocks
 * prefer the explicit startTimer/recordEmit pattern.
 */
export function timed<T>(category: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const t = startTimer();
  try {
    return fn();
  } finally {
    recordEmit(category, t);
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
 * disabled. Designed to be parser-friendly: each row starts with the
 * `[jobs-seo-profile]` marker so workflow steps can grep the line set.
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
    `[jobs-seo-profile] ${'category'.padEnd(28)} ${'count'.padStart(7)} ${'total_ms'.padStart(10)} ${'%'.padStart(5)} ${'avg_ms'.padStart(8)} ${'p50_ms'.padStart(8)} ${'p99_ms'.padStart(8)} ${'min_ms'.padStart(7)} ${'max_ms'.padStart(8)}`,
  );
  for (const r of rows) {
    const pct = totalMsAll > 0 ? (r.totalMs / totalMsAll) * 100 : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[jobs-seo-profile] ${r.category.padEnd(28)} ${String(r.count).padStart(7)} ${r.totalMs.toFixed(1).padStart(10)} ${pct.toFixed(1).padStart(5)} ${r.avgMs.toFixed(2).padStart(8)} ${r.p50Ms.toFixed(2).padStart(8)} ${r.p99Ms.toFixed(2).padStart(8)} ${r.minMs.toFixed(2).padStart(7)} ${r.maxMs.toFixed(2).padStart(8)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[jobs-seo-profile] ${'TOTAL'.padEnd(28)} ${String(totalCountAll).padStart(7)} ${totalMsAll.toFixed(1).padStart(10)}`,
  );
}

/**
 * Reset all collected stats. Mainly useful for tests; not called from the
 * plugin (which lives one-shot per build).
 */
export function resetProfiler(): void {
  buckets.clear();
}

/** True if the profiler is active for this process. */
export function isEnabled(): boolean {
  return ENABLED;
}
