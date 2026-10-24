/**
 * Workload percentage of a Swiss job ad, and the employment type it implies.
 *
 * Kept free of Node imports: the crawlers use it (via
 * `dedicated-crawler-common.mjs`) and so does the JobPosting builder in
 * `build-plugins/shared/jobPostingSchema.ts`, which also runs in the SPA
 * bundle.
 */

/**
 * The upper bound of a workload range, or the single workload, written in the
 * text; `NaN` when there is none.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function workloadPercent(text) {
  // Both range spellings occur in the wild: "70-100%" and "70% - 100%".
  const range = String(text).match(/\b(\d{1,3})\s*%?\s*[-–—]\s*(\d{1,3})\s*%/);
  if (range) return Math.max(Number(range[1]), Number(range[2]));
  const single = String(text).match(/\b(\d{1,3})\s*%/);
  return single ? Number(single[1]) : NaN;
}

/** Below this workload a Swiss ad is part-time (`normalizeContract`'s rule). */
export const PART_TIME_MAX_WORKLOAD = 90;

/**
 * True when the text states a part-time workload ("60%", "20-40 %").
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isPartTimeWorkload(text) {
  const percent = workloadPercent(text);
  return Number.isFinite(percent) && percent > 0 && percent < PART_TIME_MAX_WORKLOAD;
}
