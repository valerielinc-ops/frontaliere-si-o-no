/**
 * Cross-run checkpoint + incremental-merge helpers for crawlers whose full
 * catalog can't fit in a single scheduled run (guidle: 119'800 events,
 * myswitzerland: tens of thousands — both at politeness-delay pace, minutes
 * not hours, per scheduled invocation). Each run visits a bounded, time-
 * budgeted slice of the catalog starting where the previous run left off
 * (`loadCursor`/`saveCursor`), and merges whatever it found into the
 * existing on-disk slice (`mergeEventsIntoSlice`) instead of overwriting it
 * wholesale — so a killed/budget-exhausted run never loses prior progress,
 * and full coverage accrues across many scheduled runs (issue #3125: "no
 * pilot batch, must be complete" — no permanent cap on total events).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_SLICE_DIR } from './events-utils.mjs';
import { applyDetailFailureReuse } from './detail-failure-reuse-policy.mjs';
import { mergeEventHistory, publishedEventRoutes } from './events-retention.mjs';
import { appendPrivateEventDescriptionSources, sanitizeEventForPublication } from './event-description-policy.mjs';

export const CHECKPOINT_DIR = path.join(EVENTS_SLICE_DIR, '..', 'checkpoints');

/** Index to resume from in this source's catalog; 0 if no checkpoint yet. */
export function loadCursor(sourceKey, checkpointDir = CHECKPOINT_DIR) {
  const file = path.join(checkpointDir, `${sourceKey}.json`);
  if (!existsSync(file)) return 0;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return Number.isInteger(data.nextIndex) && data.nextIndex >= 0 ? data.nextIndex : 0;
  } catch {
    return 0;
  }
}

export function saveCursor(sourceKey, nextIndex, updatedAt, checkpointDir = CHECKPOINT_DIR) {
  mkdirSync(checkpointDir, { recursive: true });
  const file = path.join(checkpointDir, `${sourceKey}.json`);
  writeFileSync(file, `${JSON.stringify({ nextIndex, updatedAt }, null, 2)}\n`, 'utf-8');
}

/**
 * Generic cross-run cursor for crawlers whose resume position isn't a single
 * numeric index — e.g. a Common Crawl sweep needs collection + next page +
 * the set of pages already swept this pass. `loadCursor`/`saveCursor` above
 * fix the shape (`{ nextIndex, updatedAt }`) to match the events-slice
 * checkpoint already in production, so a second source with a richer cursor
 * can't reuse them without changing that shape. These read/write an
 * arbitrary JSON-serializable cursor at an explicit path instead, keeping
 * only the boilerplate (missing/corrupt → fallback, write → mkdir + pretty
 * JSON) shared, so a new source doesn't reimplement it from scratch.
 */
export function loadGenericCursor(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function saveGenericCursor(filePath, cursor) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(cursor, null, 2)}\n`, 'utf-8');
}

/**
 * Upsert `freshEvents` (by stable `id`) into the slice already on disk.
 *
 * Event URLs are an SEO archive: an event dropping out of a source listing,
 * being explicitly reported in `goneIds`, or ending in the past is NOT proof
 * that its published URL may be deleted. `goneIds` is retained in the API for
 * crawler diagnostics and forward compatibility, but deliberately has no
 * destructive effect here. When a record changes its date/title/location,
 * mergeEventHistory carries the old route into `previousRoutes`.
 * Returns the resulting total event count.
 */
export function mergeEventsIntoSlice({
  slicePath,
  sourceKey,
  sourceName,
  canton,
  freshEvents,
  goneIds,
  crawledAt,
  detailFailureIds = [],
  detailAttemptCount,
  detailFailureStrategy = 'reuse-or-reject',
}) {
  let existing = [];
  if (existsSync(slicePath)) {
    try {
      const parsed = JSON.parse(readFileSync(slicePath, 'utf-8'));
      if (Array.isArray(parsed.events)) existing = parsed.events;
    } catch {
      existing = [];
    }
  }

  // Source descriptions may exist in crawler memory, but this is the last
  // boundary before a slice becomes versioned. Keep an opt-in private JSONL
  // copy for the rewrite backlog, then remove the prose from both new and old
  // rows before detail-reuse, history, and the write below.
  appendPrivateEventDescriptionSources(freshEvents);
  const safeFreshEvents = freshEvents.map(sanitizeEventForPublication);
  const safeExistingEvents = existing.map(sanitizeEventForPublication);

  const detailReuse = applyDetailFailureReuse({
    freshRows: safeFreshEvents,
    failedIdentities: detailFailureIds,
    attemptedCount: detailAttemptCount,
    previousRows: safeExistingEvents,
    identityOf: (event) => event?.id,
    requireReuse: false,
    fallbackOf: (previous) => {
      if (!previous?.id || !String(previous.title || '').trim() || !String(previous.startDate || '').trim()) {
        return null;
      }
      return { ...previous };
    },
  });
  // MySwitzerland has an independently verified Algolia event row. When its
  // detail transport stops on the 406 policy threshold, the caller may make
  // that source-backed fallback explicit. It must still provide a fresh row
  // for every failed identity; other sources keep the shared reject policy.
  const freshEventIds = new Set(
    safeFreshEvents.map((event) => (typeof event?.id === 'string' ? event.id.trim() : '')).filter(Boolean),
  );
  const canPublishSourceBackedIndex = sourceKey === 'myswitzerland'
    && detailFailureStrategy === 'source-backed-index'
    && detailReuse.detailFailureCount > 0
    && detailReuse.invalidFailureIdentityCount === 0
    && detailReuse.duplicateFailureIdentityCount === 0
    && detailReuse.previousSnapshotIdentityCollisionCount === 0
    && detailReuse.detailFailureIdentities.every((identity) => freshEventIds.has(identity));
  if (!detailReuse.canPublish && !canPublishSourceBackedIndex) {
    throw new Error(
      `[${sourceKey}] detail failure/reuse policy rejected ${detailReuse.detailFailureCount}/`
      + `${detailReuse.attemptedCount} attempted detail(s)`,
    );
  }
  if (canPublishSourceBackedIndex) {
    console.warn(
      `[${sourceKey}] detail failure/reuse policy exceeded; publishing the explicit source-backed index fallback`,
    );
  }
  if (detailReuse.detailFailureCount > 0) {
    console.warn(
      `[${sourceKey}] detail failure/reuse accounting: ${detailReuse.detailFailureCount} failed, `
      + `${canPublishSourceBackedIndex ? 'index-backed rows published' : `${detailReuse.reusedDetailCount} previous snapshot row(s) reused`}`,
    );
  }

  const byId = new Map(safeExistingEvents.map((event) => [event.id, event]));
  const previousRoutes = publishedEventRoutes(
    safeExistingEvents,
    typeof crawledAt === 'string' ? crawledAt.slice(0, 10) : undefined,
  );
  // Deliberately retain goneIds: source disappearance is a crawl observation,
  // not authorization to erase a public event URL.
  const rowsToMerge = canPublishSourceBackedIndex ? safeFreshEvents : detailReuse.rows;
  for (const event of rowsToMerge) {
    if (!event?.id) continue;
    const previous = byId.get(event.id);
    byId.set(
      event.id,
      previous ? mergeEventHistory(previous, event, previousRoutes.get(event.id)) : event,
    );
  }

  // Keep the parameter part of the explicit contract even though it is now
  // non-destructive by design; this makes accidental reintroduction of a
  // delete loop obvious in review.
  void goneIds;
  const events = [...byId.values()];

  mkdirSync(path.dirname(slicePath), { recursive: true });
  const slice = {
    schemaVersion: 1,
    sourceKey,
    sourceName,
    ...(canton ? { canton } : {}),
    assembledAt: crawledAt,
    events,
  };
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
  return events.length;
}
