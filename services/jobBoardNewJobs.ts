export interface JobBoardNewnessFields {
  firstSeenAt?: unknown;
  crawledAt?: unknown;
  postedDate?: unknown;
}

export const JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY = 'frontaliere_job_board_new_jobs_impression_visit_v1';

export interface JobBoardNewJobsImpressionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Create a per-visit impression gate. sessionStorage carries the last visit
 * across reloads; the closure covers remounts when storage is unavailable.
 */
export function createJobBoardNewJobsImpressionGate() {
  const seenVisits = new Set<string>();

  return (visitKey: string, storage: JobBoardNewJobsImpressionStorage | null): boolean => {
    const key = String(visitKey || '').trim();
    if (!key || seenVisits.has(key)) return false;

    try {
      if (storage?.getItem(JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY) === key) {
        seenVisits.add(key);
        return false;
      }
    } catch {
      // A blocked sessionStorage must not break the user's interaction.
    }

    seenVisits.add(key);
    if (seenVisits.size > 32) seenVisits.delete(seenVisits.values().next().value as string);

    try {
      storage?.setItem(JOB_BOARD_NEW_JOBS_IMPRESSION_VISIT_KEY, key);
    } catch {
      // The in-memory set still dedupes remounts in this page lifetime.
    }
    return true;
  };
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

/** Alert deep links may open on a known city listing, but never on job detail. */
export function canOpenJobBoardAlertOnRoute(options: {
  requestHandled: boolean;
  alertsEnabled: boolean;
  initialJobSlug?: string;
  locationSlugFilter?: string | null;
  hasSelectedJob: boolean;
}): boolean {
  const { requestHandled, alertsEnabled, initialJobSlug, locationSlugFilter, hasSelectedJob } = options;
  return !requestHandled
    && alertsEnabled
    && (!initialJobSlug || Boolean(locationSlugFilter))
    && !hasSelectedJob;
}
