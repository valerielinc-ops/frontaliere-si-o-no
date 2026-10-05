/**
 * One set for every number of a crawler summary.
 *
 * A per-crawler summary (data/jobs-crawler-summaries/by-crawler/<key>.json)
 * declares `total`/`written` and the partition `newCount + updatedCount +
 * unchangedCount` of the SAME active slice; L3 Job Quality
 * (scripts/ci/loop-l3-job-quality.mjs) checks exactly that equality.
 *
 * The crawlers used to fill the two halves from different sets: the diff was
 * computed on the merged rows BEFORE localization/validation (crawler
 * template step 4, and the same shape in ~130 dedicated scripts), while
 * `total` was the length of the array handed to the slice writer AFTER those
 * steps, and the slice writer itself can still drop rows (hardening, ownership
 * guard). Measured on main 2026-10-04: 60 of 624 summaries rewritten after the
 * fix of the issue 8407 cause #1 still broke the partition (anker-swiss total
 * 223 vs 269, agie-charmilles 29 vs 26, galenica 352 vs 1).
 *
 * The only set both halves can honestly describe is the slice this process
 * actually published. The slice writer records, per crawler key, the slice the
 * run started from (the previous run's, crawler-previous-run-slice.mjs) and
 * the jobs it finally wrote; the summary writer then derives total, written,
 * the four counts and the four evidence lists from that pair. A summary written without a slice write in
 * the same process (exit guards, soft exits) keeps the values its caller
 * declared.
 */
import { buildStableJobIdentity, jobsDiffer } from './job-identity.mjs';

/** Evidence lists in a summary are capped, the counts are not. */
export const SUMMARY_LIST_CAP = 30;

/**
 * Partition the published jobs against the previous slice.
 *
 * Iterates the published ARRAY (not an identity map), so
 * `newJobs + updatedJobs + unchangedJobs` always has exactly
 * `afterJobs.length` rows, duplicates included.
 *
 * @param {object[]} beforeJobs jobs of the previous run's slice
 * @param {object[]} afterJobs jobs this run wrote to the slice
 */
export function computeSlicePartition(beforeJobs, afterJobs) {
  const before = new Map();
  for (const job of Array.isArray(beforeJobs) ? beforeJobs : []) {
    if (!job || typeof job !== 'object') continue;
    const identity = buildStableJobIdentity(job);
    if (!before.has(identity)) before.set(identity, job);
  }
  const after = Array.isArray(afterJobs) ? afterJobs : [];
  const afterIdentities = new Set();
  const newJobs = [];
  const updatedJobs = [];
  const unchangedJobs = [];
  for (const job of after) {
    const identity = job && typeof job === 'object' ? buildStableJobIdentity(job) : null;
    if (identity) afterIdentities.add(identity);
    const previous = identity ? before.get(identity) : undefined;
    if (!previous) newJobs.push(job);
    else if (jobsDiffer(previous, job)) updatedJobs.push(job);
    else unchangedJobs.push(job);
  }
  const removedJobs = [];
  for (const [identity, job] of before) {
    if (!afterIdentities.has(identity)) removedJobs.push(job);
  }
  return { total: after.length, newJobs, updatedJobs, unchangedJobs, removedJobs };
}

/**
 * Rewrite the set-dependent fields of a summary from the published slice.
 * Fields that describe the source (discovered, parsed, failures, timing...)
 * are left as declared.
 *
 * @param {object} summaryEntry summary as declared by the crawler
 * @param {{ beforeJobs: object[], afterJobs: object[] }} published
 * @returns {{ summary: object, changed: string[] }}
 */
export function alignSummaryWithPublishedSlice(summaryEntry, published) {
  const partition = computeSlicePartition(published?.beforeJobs, published?.afterJobs);
  const derived = {
    total: partition.total,
    newCount: partition.newJobs.length,
    updatedCount: partition.updatedJobs.length,
    removedCount: partition.removedJobs.length,
    unchangedCount: partition.unchangedJobs.length,
  };
  if (Object.prototype.hasOwnProperty.call(summaryEntry, 'written')) derived.written = partition.total;
  const changed = [];
  for (const [field, value] of Object.entries(derived)) {
    if (summaryEntry[field] !== value) changed.push(`${field} ${summaryEntry[field]}→${value}`);
  }
  return {
    summary: {
      ...summaryEntry,
      ...derived,
      newJobs: partition.newJobs.slice(0, SUMMARY_LIST_CAP),
      updatedJobs: partition.updatedJobs.slice(0, SUMMARY_LIST_CAP),
      removedJobs: partition.removedJobs.slice(0, SUMMARY_LIST_CAP),
      unchangedJobs: partition.unchangedJobs.slice(0, SUMMARY_LIST_CAP),
    },
    changed,
  };
}

// Per-process record of the slices written by writeJobsCrawlerSlice.
const publishedSlices = new Map();

/**
 * Called by the slice writer after every successful write. The FIRST write of
 * a key in this process fixes `beforeJobs` (the slice the run started from);
 * every later write only replaces `afterJobs`.
 */
export function recordPublishedSlice(crawlerKey, { beforeJobs, afterJobs }) {
  const previous = publishedSlices.get(crawlerKey);
  publishedSlices.set(crawlerKey, {
    beforeJobs: previous ? previous.beforeJobs : (Array.isArray(beforeJobs) ? beforeJobs : []),
    afterJobs: Array.isArray(afterJobs) ? afterJobs : [],
  });
}

export function publishedSliceFor(crawlerKey) {
  return publishedSlices.get(crawlerKey) || null;
}

/** Tests only. */
export function resetPublishedSlices() {
  publishedSlices.clear();
}
