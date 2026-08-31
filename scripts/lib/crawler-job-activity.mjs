/**
 * Classify records stored in a crawler slice for metrics that describe the
 * latest authoritative crawl.
 *
 * A positive `crawlerMissStreak` means the record was not observed in the
 * latest run and is retained only by the crawler's bounded grace policy. An
 * `expiredAt` value is the canonical marker used by the expired-job archive.
 * Neither record belongs in active-quality denominators, but both remain
 * visible through the returned exclusion counters.
 *
 * Unknown or malformed metadata stays active (fail-open for measurement): an
 * audit must never hide a live record merely because a new source field has an
 * unexpected value.
 *
 * @param {unknown} job
 * @returns {'active'|'grace'|'expired'}
 */
export function crawlerJobActivity(job) {
  if (!job || typeof job !== 'object') return 'active';
  const record = /** @type {Record<string, unknown>} */ (job);
  if (typeof record.expiredAt === 'string' && record.expiredAt.trim()) return 'expired';
  if (Number(record.crawlerMissStreak) > 0) return 'grace';
  return 'active';
}

/**
 * @param {unknown} jobs
 * @returns {{ activeJobs: object[], excluded: { grace: number, expired: number, total: number } }}
 */
export function partitionCrawlerJobsForActiveMetrics(jobs) {
  const activeJobs = [];
  const excluded = { grace: 0, expired: 0, total: 0 };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const activity = crawlerJobActivity(job);
    if (activity === 'active') {
      activeJobs.push(job);
      continue;
    }
    excluded[activity] += 1;
    excluded.total += 1;
  }
  return { activeJobs, excluded };
}
