/**
 * Publisher ad analytics — per-ad view + apply-click counters.
 *
 * Mirrors services/jobViewsService.ts: fire-and-forget Firestore increments,
 * never blocks rendering. Views remain session-debounced; apply clicks use an
 * explicit event key so two real clicks in one session remain two events.
 * Writes to
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

export const APPLY_CLICK_DEDUP_WINDOW_MS = 5_000;

export interface ApplyClickDedupInput {
  eventId?: string | null;
  previousEventId?: string | null;
  previousEventAtMs?: number | null;
  nowMs?: number;
}

export interface ApplyClickDedupDecision {
  record: boolean;
  removed: number;
  reason?: 'technical_duplicate';
}

/**
 * Pure decision for the only apply-click collapse we permit: the same
 * explicit event key arriving again inside the short technical retry window.
 */
export function decideApplyClickDedup(input: ApplyClickDedupInput = {}): ApplyClickDedupDecision {
  const eventId = input.eventId ? String(input.eventId) : '';
  const previousEventId = input.previousEventId ? String(input.previousEventId) : '';
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const previousEventAtMs = Number(input.previousEventAtMs);
  const sameKey = Boolean(eventId && previousEventId && eventId === previousEventId);
  const insideRetryWindow = Number.isFinite(previousEventAtMs)
    && nowMs >= previousEventAtMs
    && nowMs - previousEventAtMs <= APPLY_CLICK_DEDUP_WINDOW_MS;
  if (sameKey && insideRetryWindow) return { record: false, removed: 1, reason: 'technical_duplicate' };
  return { record: true, removed: 0 };
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

function generatedEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through to a local, non-identifying key when Web Crypto is absent.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Create one stable key for all telemetry emitted by a single UI action. */
export function createPublisherApplyEventId(): string {
  return generatedEventId();
}

function timestampMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (value && typeof value === 'object') {
    const candidate = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
    if (typeof candidate.toMillis === 'function') return candidate.toMillis();
    if (typeof candidate.toDate === 'function') return timestampMillis(candidate.toDate());
    if (typeof candidate.seconds === 'number') return candidate.seconds * 1_000;
  }
  return null;
}

/**
 * Transactional apply-click increment. The retry key and removal counter live
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
      const recentKeys = Array.isArray(data.applyClickDedupRecentKeys)
        ? data.applyClickDedupRecentKeys
          .filter((entry: unknown): entry is { key: string; at: number } => {
            const item = entry as { key?: unknown; at?: unknown };
            return typeof item.key === 'string' && Number.isFinite(Number(item.at))
              && nowMs >= Number(item.at)
              && nowMs - Number(item.at) <= APPLY_CLICK_DEDUP_WINDOW_MS;
          })
        : [];
      const recentMatch = recentKeys.find((entry) => entry.key === eventId);
      const decision = decideApplyClickDedup({
        eventId,
        previousEventId: recentMatch?.key || data.lastApplyClickEventKey,
        previousEventAtMs: recentMatch?.at || timestampMillis(data.lastApplyClickEventAt),
        nowMs,
      });
      const update: Record<string, unknown> = {
        jobId: eventDocId,
        updatedAt: new Date(nowMs),
        applyClicksDeduplication: {
          strategy: 'explicit_event_key',
          key: 'applyClickDedupRecentKeys',
          windowMs: APPLY_CLICK_DEDUP_WINDOW_MS,
          sessionDebounce: false,
        },
        applyClicksTechnicalDuplicatesRemoved: fsIncrement(decision.removed),
        applyClickDedupRecentKeys: decision.record
          ? [...recentKeys, { key: eventId, at: nowMs }].slice(-32)
          : recentKeys,
      };
      if (decision.record) {
        update.applyClicks = fsIncrement(1);
        update.lastApplyClickEventKey = eventId;
        update.lastApplyClickEventAt = new Date(nowMs);
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
  return incrementApplyClick(eventDocId, options.eventId || createPublisherApplyEventId());
}
