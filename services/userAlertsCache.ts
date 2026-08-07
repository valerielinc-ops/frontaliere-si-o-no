/**
 * Per-session cache of `getUserAlerts(userId)` — extracted from JobBoard.tsx
 * (#5012) because it stopped being one component's concern.
 *
 * Every CTA that can create or cancel an alert has to invalidate it, or the
 * next surface reads a list one write behind and wrongly shows (or hides) its
 * own CTA. That was true while the writers all lived inside JobBoard; it stopped
 * being true when the CompanyAlert CTA moved onto the SSG employer pages, the
 * expired-ad view and the orphan view, which are separate modules and could not
 * reach the file-private `cachedUserAlerts` at all — so their writes silently
 * left the cache stale for the rest of the session.
 *
 * Module state on purpose, not persisted: a fresh page load always re-checks
 * server-side.
 */
import type { JobAlert } from '@/services/jobAlertService';

let cachedUserAlerts: { userId: string; promise: Promise<JobAlert[]> } | null = null;

export function fetchUserAlertsCached(
  userId: string,
  getUserAlerts: (userId: string) => Promise<JobAlert[]>,
): Promise<JobAlert[]> {
  if (cachedUserAlerts && cachedUserAlerts.userId === userId) return cachedUserAlerts.promise;
  const promise = getUserAlerts(userId);
  cachedUserAlerts = { userId, promise };
  // Don't cache a rejected fetch — let the next caller retry rather than replay
  // a stale failure for the rest of the session.
  promise.catch(() => {
    if (cachedUserAlerts?.promise === promise) cachedUserAlerts = null;
  });
  return promise;
}

/**
 * Invalidate after ANY successful alert creation or cancellation, from any
 * surface — the job-match pill, the board-filter CTA, the job-detail button and
 * prompt, and every CompanyAlert follow CTA. They all mutate the one list each
 * cached read reflects.
 */
export function invalidateUserAlertsCache(): void {
  cachedUserAlerts = null;
}
