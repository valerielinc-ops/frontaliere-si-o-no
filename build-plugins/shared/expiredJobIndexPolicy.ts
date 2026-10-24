// expiredJobIndexPolicy.ts
//
// P1 noindex plan (2026-10-24): when an expired job's soft-landing page stops
// being indexable.
//
// An expired offer keeps a 200 soft-landing (archive notice, same-company
// live jobs, links back to the board) and keeps its existing structured data
// — this policy only decides the robots directive and sitemap membership.
// It stays `index,follow` (on top of the existing ≥50-word floor) while EITHER
//
//   - it expired less than EXPIRED_JOB_INDEX_GRACE_DAYS ago: the window in
//     which a searcher still looks for that specific posting (re-posts,
//     "is it still open?") and in which Google is still recrawling the URL
//     to learn it expired; OR
//   - any URL of the job (every locale, current and legacy canton section)
//     had a Search Console impression in the last 90 days.
//
// Otherwise `noindex,follow`, out of sitemap-jobs-expired.xml, never 404/410.
//
// Why 30 days. Measured on 2026-10-24 over the 50 276 expired jobs in
// data/jobs/expired/by-crawler/: 19 290 expired in the last 30 days; of the
// 30 986 older ones, 4 182 still have Search Console impressions (kept by the
// second rule) and 26 804 have none — and none of those 26 804 had a click.
// A job without a recorded `expiredAt` is never noindexed by age: absence of
// a date is not proof of age (the #5168 inert-band rule).

import type { GscDemandEvidence } from './trafficEvidenceFilter';

export const EXPIRED_JOB_INDEX_GRACE_DAYS = 30;

export type ExpiredJobDemandEvidence = Pick<GscDemandEvidence, 'active' | 'hasImpressions'>;

export function isExpiredJobDemandIndexable(
  job: { readonly expiredAt?: string | null; readonly paths: readonly string[] },
  demand: ExpiredJobDemandEvidence,
  nowMs: number = Date.now(),
): boolean {
  // Dormant evidence → pre-P1 behaviour (the ≥50-word floor alone decides).
  if (!demand.active) return true;
  const expiredMs = Date.parse(String(job.expiredAt ?? ''));
  if (!Number.isFinite(expiredMs)) return true;
  if (nowMs - expiredMs < EXPIRED_JOB_INDEX_GRACE_DAYS * 86_400_000) return true;
  return demand.hasImpressions(job.paths);
}
