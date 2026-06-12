/**
 * Median of REAL salaries across a set of job records.
 *
 * ~61% of jobs.json carries an identical sector-estimated band written by
 * scripts/re-enrich-jobs.mjs (e.g. 49'500–75'000 for the default sector).
 * Including those estimates collapses any "live median" to the same ~62k
 * figure for every profession/city/cluster, contradicting the curated
 * salary facts shown next to it. Only `reported` / `existing` salaries
 * count; records without `salarySource` (not yet re-enriched) keep the
 * legacy behaviour and are included.
 *
 * One definition shared by the profession / nursing / city / career
 * aggregates — the midpoint+median loop used to be copy-pasted in all four
 * (AGENTS.md rule: duplicated construct → one module).
 */

export interface SalaryCarrier {
  salaryMin?: number | null;
  salaryMax?: number | null;
  /** 'reported' | 'existing' | 'estimated' — persisted by re-enrich-jobs.mjs. */
  salarySource?: string;
}

/** Annual midpoint of a job's salary band, or null when absent. */
export function jobSalaryMidpoint(job: SalaryCarrier): number | null {
  const min = typeof job.salaryMin === 'number' ? job.salaryMin : null;
  const max = typeof job.salaryMax === 'number' ? job.salaryMax : null;
  if (min && max) return Math.round((min + max) / 2);
  if (min) return min;
  if (max) return max;
  return null;
}

/**
 * Median of non-estimated salary midpoints. Fewer than `minSamples`
 * (default 3) real data points is not a meaningful median → null (callers
 * fall back to their curated/editorial salary range).
 */
export function realSalaryMedianChf(
  jobs: readonly SalaryCarrier[],
  minSamples = 3,
): number | null {
  const values: number[] = [];
  for (const job of jobs) {
    if (job.salarySource === 'estimated') continue;
    const mid = jobSalaryMidpoint(job);
    if (mid) values.push(mid);
  }
  // Same guard as the legacy per-plugin median(): finite, positive values only.
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length < minSamples) return null;
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[half]
    : Math.round((sorted[half - 1] + sorted[half]) / 2);
}
