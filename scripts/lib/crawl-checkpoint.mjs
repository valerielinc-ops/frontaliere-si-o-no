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
 * Upsert `freshEvents` (by stable `id`) into the slice already on disk,
 * drop any id in `goneIds` (events explicitly revisited and confirmed
 * expired/removed this run), and prune anything whose last relevant date
 * (endDate || startDate) is already in the past — a source-agnostic
 * safety net so events that silently drop out of a source's own listing
 * (and are therefore never revisited/explicitly marked gone) don't linger
 * in the slice forever. Returns the resulting total event count.
 */
export function mergeEventsIntoSlice({ slicePath, sourceKey, sourceName, freshEvents, goneIds, crawledAt }) {
  let existing = [];
  if (existsSync(slicePath)) {
    try {
      const parsed = JSON.parse(readFileSync(slicePath, 'utf-8'));
      if (Array.isArray(parsed.events)) existing = parsed.events;
    } catch {
      existing = [];
    }
  }

  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const id of goneIds || []) byId.delete(id);
  for (const event of freshEvents) byId.set(event.id, event);

  const todayIso = String(crawledAt).slice(0, 10);
  const events = [...byId.values()].filter((event) => {
    const lastRelevant = event.endDate || event.startDate;
    return !lastRelevant || lastRelevant >= todayIso;
  });

  mkdirSync(path.dirname(slicePath), { recursive: true });
  const slice = { schemaVersion: 1, sourceKey, sourceName, assembledAt: crawledAt, events };
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
  return events.length;
}
