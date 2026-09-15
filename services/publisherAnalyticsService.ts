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

/** Keep the auditable ledger bounded; overflow is detected without evicting IDs. */
export const MAX_APPLY_CLICK_EMISSION_IDS = 64;

export interface ApplyClickEmissionLedgerUpdate {
  emissionIds: string[];
  unavailable: number;
}

/**
 * Append one emission id while preserving every ID already retained. Once the
 * ledger is full, an unknown ID is not appended: the caller must mark that
 * event as dedup-unavailable instead of silently evicting an older ID.
 */
export function appendApplyClickEmissionId(
  seenEventIds: readonly (string | null | undefined)[],
  eventId?: string | null,
): ApplyClickEmissionLedgerUpdate {
  const normalizedIds = seenEventIds
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const normalizedEventId = String(eventId || '').trim();
  if (!normalizedEventId || normalizedIds.includes(normalizedEventId)) {
    return { emissionIds: normalizedIds, unavailable: 0 };
  }
  if (normalizedIds.length >= MAX_APPLY_CLICK_EMISSION_IDS) {
    return { emissionIds: normalizedIds, unavailable: 1 };
  }
  return {
    emissionIds: [...normalizedIds, normalizedEventId],
    unavailable: 0,
  };
}

/**
 * Pure decision for the only apply-click collapse we permit: the same
 * explicit emission id arriving again. Missing ids remain counted and are
 * reported as unavailable instead of being guessed as duplicates. Once the
 * bounded ledger is full, an unknown id is not counted because it may be a
 * retry whose original entry cannot be retained.
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
  if (seenEventIds.size >= MAX_APPLY_CLICK_EMISSION_IDS) {
    return {
      record: false,
      removed: 0,
      unavailable: 1,
      status: 'dedup non disponibile',
      reason: 'dedup_unavailable',
    };
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
/**
 * Resolve the deduplication state written on this transaction, fail-closed.
 *
 * The status is decided by the running unavailable count, so a stored value we
 * cannot read is not a zero: `Number(value) || 0` on a junk field silently
 * downgraded a document that is NOT provably deduplicated back to `available`,
 * and the read side then trusts that status. Absent is different from junk —
 * a document written before the ledger existed simply has no counter yet.
 */
export function resolveApplyClickDedupState(
  storedUnavailable: unknown,
  addedUnavailable: number,
): { status: 'available' | 'dedup non disponibile'; unavailableCount: number } {
  const added = Number.isFinite(addedUnavailable) && addedUnavailable > 0 ? addedUnavailable : 0;
  // Only ABSENT means "never written". An explicit `null` is a value, and it is
  // not a readable count — so it fails closed like any other junk.
  if (storedUnavailable === undefined) {
    return { status: added > 0 ? 'dedup non disponibile' : 'available', unavailableCount: added };
  }
  const previous = typeof storedUnavailable === 'number'
    && Number.isInteger(storedUnavailable)
    && storedUnavailable >= 0
    ? storedUnavailable
    : null;
  if (previous === null) {
    // Unreadable history: we cannot prove the earlier units were deduplicated,
    // so we do not claim they were.
    return { status: 'dedup non disponibile', unavailableCount: added };
  }
  const unavailableCount = previous + added;
  return {
    status: unavailableCount > 0 ? 'dedup non disponibile' : 'available',
    unavailableCount,
  };
}

export function createPublisherApplyEventId(): string {
  return createAnalyticsEmissionId();
}

/**
 * Transactional apply-click increment. The bounded emission-id ledger and removal
 * counter live beside the counter, making the deduplication decision auditable
 * without persisting an event payload or a browser session marker. Once the
 * ledger is full, unknown ids are not counted and are marked dedup-unavailable
 * so an evicted retry can never be silently recounted.
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
      const ledgerUpdate = appendApplyClickEmissionId(
        seenEventIds,
        decision.record ? eventId : null,
      );
      const unavailable = decision.unavailable + ledgerUpdate.unavailable;
      const dedupState = resolveApplyClickDedupState(data.applyClicksDedupUnavailable, unavailable);
      const update: Record<string, unknown> = {
        jobId: eventDocId,
        updatedAt: new Date(nowMs),
        applyClicksDeduplication: {
          strategy: 'emission_id_only',
          key: 'emission_id',
          status: dedupState.status,
          unavailableCount: dedupState.unavailableCount,
        },
        applyClicksTechnicalDuplicatesRemoved: fsIncrement(decision.removed),
        applyClicksDedupUnavailable: fsIncrement(unavailable),
        applyClickEmissionIds: ledgerUpdate.emissionIds,
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
