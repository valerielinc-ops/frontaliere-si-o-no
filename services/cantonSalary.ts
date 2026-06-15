/**
 * cantonSalary.ts — SPA-side per-canton salary scaling.
 *
 * The SalaryCompare stats page holds national-CH gross figures (SALARY_DATA).
 * To show a single canton, the national figure is scaled by the canton's wage
 * level relative to the national median, using the same official BFS index
 * (data/swiss-canton-salary-index.json) that drives the pipeline estimator and
 * the SEO prose. Reading the JSON keeps this in lock-step with that single
 * source of truth (no duplicated constants).
 */
import index from '@/data/swiss-canton-salary-index.json';

/** Sentinel for the national (all-Switzerland) view — scale 1.0. */
export const NATIONAL_CANTON = 'CH';

const CANTON_TO_REGION = index.cantonToGrossregion as Record<string, string>;
const REGION_MEDIAN = index.grossregionMedianMonthly as Record<string, number>;
const NATIONAL_MEDIAN = index.nationalMedianMonthly as number;

/** BFS canton codes that have a salary mapping, in a stable order. */
export const SALARY_CANTON_CODES: readonly string[] = Object.freeze(
  Object.keys(CANTON_TO_REGION).sort(),
);

/**
 * Scale a national-CH gross salary to a canton: grossregionMedian /
 * nationalMedian. The national sentinel (or any unknown code) returns 1.0, so
 * the default view is unchanged.
 */
export function cantonGrossScale(code: string | null | undefined): number {
  const c = String(code || '').toUpperCase().trim();
  if (!c || c === NATIONAL_CANTON) return 1;
  const region = CANTON_TO_REGION[c];
  const median = REGION_MEDIAN[region];
  return region && median && NATIONAL_MEDIAN ? median / NATIONAL_MEDIAN : 1;
}
