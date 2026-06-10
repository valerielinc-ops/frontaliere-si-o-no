/**
 * Publisher ad analytics — per-ad view + apply-click counters.
 *
 * Mirrors services/jobViewsService.ts: fire-and-forget Firestore increments,
 * session-debounced, never blocks rendering. Writes to
 * `publisher_job_events/{publisherJobId}` (public increment, see firestore.rules).
 *
 * Only jobs that originate from the publisher portal carry `publisherJobId`
 * (set by scripts/lib/publisherJobProjection.mjs); crawled jobs have none, so
 * these helpers no-op for them.
 */

import type { Firestore } from 'firebase/firestore';

let _db: Firestore | null = null;
let _dbInit = false;

interface PublisherTrackable {
  publisherJobId?: string | null;
}

function publisherJobId(job: PublisherTrackable | string): string {
  if (typeof job === 'string') return job;
  return job?.publisherJobId ? String(job.publisherJobId) : '';
}

async function increment(eventDocId: string, field: 'views' | 'applyClicks', debouncePrefix: string): Promise<void> {
  if (!eventDocId) return;

  const debounceKey = `${debouncePrefix}_${eventDocId}`;
  try {
    if (sessionStorage.getItem(debounceKey)) return;
    sessionStorage.setItem(debounceKey, '1');
  } catch {
    // sessionStorage unavailable — proceed without debounce
  }

  try {
    if (!_dbInit) {
      _dbInit = true;
      const { getFirestore } = await import('firebase/firestore');
      const { app } = await import('@/services/firebase');
      _db = getFirestore(app);
    }
    if (!_db) return;
    const { doc, setDoc, increment: fsIncrement } = await import('firebase/firestore');
    await setDoc(
      doc(_db, 'publisher_job_events', eventDocId),
      { jobId: eventDocId, [field]: fsIncrement(1), updatedAt: new Date() },
      { merge: true },
    );
  } catch {
    // Non-blocking — analytics must never break the page.
  }
}

/** Count one view of a publisher ad (once per session). No-op for crawled jobs. */
export async function trackPublisherJobView(job: PublisherTrackable | string): Promise<void> {
  return increment(publisherJobId(job), 'views', 'pjv');
}

/** Count one apply-click on a publisher ad (once per session). No-op for crawled jobs. */
export async function trackPublisherApplyClick(job: PublisherTrackable | string): Promise<void> {
  return increment(publisherJobId(job), 'applyClicks', 'pjc');
}
