/**
 * Publisher ad analytics — per-ad view + apply-click counters.
 *
 * Mirrors services/jobViewsService.ts: fire-and-forget Firestore increments,
 * never blocks rendering. Views remain session-debounced; apply clicks use an
 * explicit emission id so two real clicks remain two events.
 * Writes to
 * `publisher_job_events/{publisherJobId}` (public increment, see firestore.rules).
 *
 * Only jobs that originate from the publisher portal carry `publisherJobId`
 * (set by scripts/lib/publisherJobProjection.mjs); crawled jobs have none, so
 * these helpers no-op for them.
 */

import type { Firestore } from 'firebase/firestore';
import { createAnalyticsEmissionId } from '@/services/analytics';

let _db: Firestore | null = null;
let _dbInit = false;

interface PublisherTrackable {
  publisherJobId?: string | null;
}

export interface ApplyClickDedupInput {
  eventId?: string | null;
  seenEventIds?: readonly (string | null | undefined)[];
}

export interface ApplyClickDedupDecision {
  record: boolean;
  removed: number;
  unavailable: number;
  status: 'available' | 'dedup non disponibile';
  reason?: 'technical_duplicate' | 'dedup_unavailable';
}

/**
 * Pure decision for the only apply-click collapse we permit: the same
 * explicit emission id arriving again. Missing ids remain counted and are
 * reported as unavailable instead of being guessed as duplicates.
 */
export function decideApplyClickDedup(input: ApplyClickDedupInput = {}): ApplyClickDedupDecision {
  const eventId = String(input.eventId || '').trim();
  if (!eventId) {
    return {
      record: true,
      removed: 0,
      unavailable: 1,
      status: 'dedup non disponibile',
      reason: 'dedup_unavailable',
    };
  }
  const seenEventIds = new Set((input.seenEventIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  if (seenEventIds.has(eventId)) {
    return { record: false, removed: 1, unavailable: 0, status: 'available', reason: 'technical_duplicate' };
  }
  return { record: true, removed: 0, unavailable: 0, status: 'available' };
}

function publisherJobId(job: PublisherTrackable | string): string {
  if (typeof job === 'string') return job;
  return job?.publisherJobId ? String(job.publisherJobId) : '';
}

async function incrementView(eventDocId: string): Promise<void> {
  if (!eventDocId) return;

  const debounceKey = `pjv_${eventDocId}`;
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
      { jobId: eventDocId, views: fsIncrement(1), updatedAt: new Date() },
      { merge: true },
    );
  } catch {
    // Non-blocking — analytics must never break the page.
  }
}

/** Create one stable key for all telemetry emitted by a single UI action. */
export function createPublisherApplyEventId(): string {
  return createAnalyticsEmissionId();
}

/**
 * Transactional apply-click increment. The emission-id ledger and removal counter live
 * beside the counter, making the deduplication decision auditable without
 * persisting an event payload or a browser session marker.
 */
async function incrementApplyClick(eventDocId: string, eventId: string): Promise<void> {
  if (!eventDocId) return;
  try {
    if (!_dbInit) {
      _dbInit = true;
      const { getFirestore } = await import('firebase/firestore');
      const { app } = await import('@/services/firebase');
      _db = getFirestore(app);
    }
    if (!_db) return;
    const { doc, increment: fsIncrement, runTransaction } = await import('firebase/firestore');
    const nowMs = Date.now();
    await runTransaction(_db, async (transaction) => {
      const reference = doc(_db!, 'publisher_job_events', eventDocId);
      const snapshot = await transaction.get(reference);
      const data = snapshot.exists() ? snapshot.data() : {};
      const seenEventIds = Array.isArray(data.applyClickEmissionIds)
        ? data.applyClickEmissionIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : [];
      const decision = decideApplyClickDedup({ eventId, seenEventIds });
      const previousUnavailable = Math.max(0, Number(data.applyClicksDedupUnavailable) || 0);
      const dedupUnavailable = previousUnavailable + decision.unavailable;
      const update: Record<string, unknown> = {
        jobId: eventDocId,
        updatedAt: new Date(nowMs),
        applyClicksDeduplication: {
          strategy: 'emission_id_only',
          key: 'emission_id',
          status: dedupUnavailable > 0 ? 'dedup non disponibile' : 'available',
          unavailableCount: dedupUnavailable,
        },
        applyClicksTechnicalDuplicatesRemoved: fsIncrement(decision.removed),
        applyClicksDedupUnavailable: fsIncrement(decision.unavailable),
        applyClickEmissionIds: decision.record && eventId
          ? [...seenEventIds, eventId]
          : seenEventIds,
      };
      if (decision.record) {
        update.applyClicks = fsIncrement(1);
      }
      transaction.set(reference, update, { merge: true });
    });
  } catch {
    // Non-blocking — analytics must never break the page.
  }
}

/** Count one view of a publisher ad (once per session). No-op for crawled jobs. */
export async function trackPublisherJobView(job: PublisherTrackable | string): Promise<void> {
  return incrementView(publisherJobId(job));
}

/** Count one apply-click on a publisher ad. No-op for crawled jobs. */
export async function trackPublisherApplyClick(
  job: PublisherTrackable | string,
  options: { eventId?: string } = {},
): Promise<void> {
  const eventDocId = publisherJobId(job);
  return incrementApplyClick(eventDocId, options.eventId ? String(options.eventId).trim() : '');
}
