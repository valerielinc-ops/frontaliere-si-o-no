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

const EXPLICIT_WORKLOAD_CONTEXT = /^(?:pensum|workload|part[- ]?time|partiel|tempo\s+parziale|temps\s+partiel|beschäftigungsgrad|arbeitsgrad|fte)\b/i;

function hasWorkloadContextAfterPercent(text, end) {
  const suffix = text.slice(end).trim();
  if (!suffix) return true;
  const punctuationOnly = suffix.replace(/[)\]},.;:!?]+$/g, '').trim();
  return !punctuationOnly || EXPLICIT_WORKLOAD_CONTEXT.test(punctuationOnly);
}

function contextualWorkloadPercent(text) {
  const value = String(text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const range = value.match(/\b(\d{1,3})\s*%?\s*[-–—]\s*(\d{1,3})\s*%/);
  if (range && hasWorkloadContextAfterPercent(value, range.index + range[0].length)) {
    return Math.max(Number(range[1]), Number(range[2]));
  }
  const single = value.match(/\b(\d{1,3})\s*%/);
  if (single && hasWorkloadContextAfterPercent(value, single.index + single[0].length)) {
    return Number(single[1]);
  }
  return NaN;
}

/**
 * The workload a title states as such (at its end or next to a workload
 * word), upper bound of a range; `NaN` when it states none. Qualifier
 * percentages ("50% travel") are not workloads.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function statedWorkloadPercent(text) {
  return contextualWorkloadPercent(text);
}

/**
 * True when the text states a part-time workload ("60%", "20-40 %").
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isPartTimeWorkload(text) {
  // A percentage in a title is a workload only at the end of the title or
  // next to an explicit workload word. Qualifiers such as "50% travel" are
  // job requirements, not employment scope.
  const percent = contextualWorkloadPercent(text);
  return Number.isFinite(percent) && percent > 0 && percent < PART_TIME_MAX_WORKLOAD;
}
