#!/usr/bin/env node
/**
 * scripts/assemble-events-dataset.mjs
 *
 * Assembles the global events dataset from per-source slice files, mirroring
 * `assemble-jobs-dataset.mjs`.
 *
 * Source slices (written by each crawler):
 *   data/events/by-source/<key>.json
 *     → { schemaVersion, sourceKey, assembledAt, events: [...] }
 *
 * Assembled output (consumed by eventsSeoPagesPlugin at build time):
 *   data/events.json
 *     → { schemaVersion, generatedAt, totalEvents, events: [...] }
 *
 * Merge rules:
 *   1. Stable identity: `event.id` (already `<sourceKey>:<rawId>`).
 *   2. When the same id appears in multiple slices, the slice with the newest
 *      `assembledAt` wins (last-write wins).
 *   3. Prune past events: keep records whose (endDate || startDate) >= today.
 *   4. Sort ascending by startDate, then title.
 *
 * Usage:
 *   node scripts/assemble-events-dataset.mjs            # assemble
 *   node scripts/assemble-events-dataset.mjs --stats    # assemble + print stats
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_SLICE_DIR, EVENTS_DATASET_PATH, isoDay } from './lib/events-utils.mjs';

function readSlices() {
  if (!existsSync(EVENTS_SLICE_DIR)) return [];
  return readdirSync(EVENTS_SLICE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(EVENTS_SLICE_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter((s) => s && Array.isArray(s.events));
}

function assemble() {
  const today = isoDay(new Date());
  const slices = readSlices();
  const byId = new Map();

  for (const slice of slices) {
    const sliceTs = Date.parse(slice.assembledAt || '') || 0;
    for (const ev of slice.events) {
      if (!ev || !ev.id || !ev.startDate || !ev.title) continue;
      const end = ev.endDate || ev.startDate;
      if (end < today) continue; // prune past
      const prev = byId.get(ev.id);
      if (!prev || sliceTs >= (prev.__ts || 0)) {
        byId.set(ev.id, { ...ev, __ts: sliceTs });
      }
    }
  }

  const events = [...byId.values()]
    .map(({ __ts, ...ev }) => ev)
    .sort(
      (a, b) =>
        (a.startDate || '').localeCompare(b.startDate || '') ||
        (a.title || '').localeCompare(b.title || ''),
    );

  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    events,
  };
  writeFileSync(EVENTS_DATASET_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
  return { events, slices: slices.length };
}

function printStats(events) {
  const byComune = new Map();
  const byCategory = new Map();
  let withComune = 0;
  for (const e of events) {
    if (e.comune) {
      withComune += 1;
      byComune.set(e.comune, (byComune.get(e.comune) || 0) + 1);
    }
    if (e.category) byCategory.set(e.category, (byCategory.get(e.category) || 0) + 1);
  }
  const topComuni = [...byComune.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n── events stats ──`);
  console.log(`total: ${events.length} | with comune: ${withComune} | comuni: ${byComune.size}`);
  console.log(`top comuni: ${topComuni.map(([c, n]) => `${c}(${n})`).join(', ')}`);
  console.log(`categories: ${[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}(${n})`).join(', ')}`);
}

const { events, slices } = assemble();
console.log(`[assemble-events] merged ${slices} slice(s) → ${events.length} upcoming events → ${path.relative(process.cwd(), EVENTS_DATASET_PATH)}`);
if (process.argv.includes('--stats')) printStats(events);
