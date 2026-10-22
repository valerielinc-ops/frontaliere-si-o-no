export interface JobBoardNewnessFields {
  firstSeenAt?: unknown;
  crawledAt?: unknown;
  postedDate?: unknown;
}

/**
 * Read the timestamp used by the existing return-visit counter. Keep the
 * source precedence stable, but fail closed when that source is malformed.
 */
export function getJobBoardNewnessTimestampMs(job: JobBoardNewnessFields): number | null {
  const raw = job.firstSeenAt || job.crawledAt || job.postedDate;
  if (!raw) return null;

  let timestamp: number;
  if (typeof raw === 'number') {
    timestamp = raw;
  } else if (raw instanceof Date) {
    timestamp = raw.getTime();
  } else {
    timestamp = Date.parse(String(raw));
  }
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** A job only counts as new when both timestamps are valid and not in future. */
export function isJobBoardNewSinceVisit(
  job: JobBoardNewnessFields,
  lastVisit: number | null,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(now) || now <= 0) return false;
  if (!Number.isFinite(lastVisit) || lastVisit === null || lastVisit <= 0 || lastVisit > now) return false;

  const jobTimestamp = getJobBoardNewnessTimestampMs(job);
  return jobTimestamp !== null && jobTimestamp > lastVisit && jobTimestamp <= now;
}

export function filterJobsNewSinceVisit<T extends JobBoardNewnessFields>(
  jobs: readonly T[],
  lastVisit: number | null,
  now = Date.now(),
): T[] {
  if (!Number.isFinite(now) || now <= 0) return [];
  if (!Number.isFinite(lastVisit) || lastVisit === null || lastVisit <= 0 || lastVisit > now) return [];
  return jobs.filter((job) => isJobBoardNewSinceVisit(job, lastVisit, now));
}

/** Read only the query string: the route may discard the hash during SPA boot. */
export function hasJobBoardAlertOpenRequest(search: string): boolean {
  try {
    return new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('alert') === '1';
  } catch {
    return false;
  }
}
