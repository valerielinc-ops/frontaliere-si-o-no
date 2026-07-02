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
 *   3. Cross-source fuzzy dedup (issue #3125): nationwide sources (guidle,
 *      myswitzerland) and the TI-only tio-agenda crawler can each index the
 *      SAME physical event under a different `<sourceKey>:<rawId>` id, so the
 *      by-id merge above does not catch it. A second pass groups the
 *      survivors by `(normalized title, startDate, normalized comune)` and,
 *      ONLY when a group spans 2+ DISTINCT sources, collapses it down to the
 *      single richest record — see `dedupeFuzzy` below for the scoring/
 *      tie-break rule. A same-source collision (e.g. two different events
 *      that happen to share a generic title and a low-confidence
 *      region-fallback comune) is left untouched — merging those would risk
 *      silently dropping a genuine event.
 *   4. Italian frontier comuni geo-link (issue #3125): every assembled event
 *      that carries `geo` but has no `italianFrontierComuni` yet (a crawler
 *      may already have attached it) gets `resolveItalianFrontierComuni`
 *      applied and the result attached when non-empty. Nationwide sources
 *      only index Swiss-side events; this tags border-zone Swiss events with
 *      the nearby Italian comuni they are relevant to (a frontaliere living
 *      just across the border), it does NOT crawl Italian municipal sites.
 *   5. Prune past events: keep records whose (endDate || startDate) >= today.
 *   6. Sort ascending by startDate, then title.
 *
 * Usage:
 *   node scripts/assemble-events-dataset.mjs            # assemble
 *   node scripts/assemble-events-dataset.mjs --stats    # assemble + print stats
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENTS_SLICE_DIR,
  EVENTS_DATASET_PATH,
  isoDay,
  normalizeText,
  resolveItalianFrontierComuni,
} from './lib/events-utils.mjs';

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

// ── Cross-source fuzzy dedup ────────────────────────────────────────────
// The same physical event (e.g. a concert in Lugano) can be indexed by more
// than one source with an unrelated raw id, so the by-id merge in assemble()
// never catches it. Two records collide here when they normalize to the same
// title, share the exact same startDate, and resolve to the same comune (a
// missing comune on both sides also counts as a match — an unattributed
// event still deserves de-duplication). Events that merely SHARE a title
// (e.g. a recurring "Mercatino" in two different towns, or the same title on
// two different dates) intentionally do NOT collapse.
function fuzzyDedupKey(ev) {
  return `${normalizeText(ev.title)}|${ev.startDate}|${normalizeText(ev.comune || '')}`;
}

// Optional fields that make an event record more useful to a reader — used
// to score which duplicate to keep. Deliberately excludes fields that are
// near-universal/cheap to fill (category, region) in favor of the fields
// that actually distinguish a "thin" crawl from a "rich" one.
const RICHNESS_FIELDS = ['description', 'imageUrl', 'price', 'address', 'geo', 'venue', 'endDate'];

function isPopulated(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Count of populated optional fields — higher means a "richer" record. */
export function eventRichnessScore(ev) {
  let score = 0;
  for (const field of RICHNESS_FIELDS) {
    if (isPopulated(ev?.[field])) score += 1;
  }
  return score;
}

// Explicit source priority for the final tie-break (equal richness score):
// tio-agenda is our original hand-tuned TI crawler (best comune attribution,
// oldest/most battle-tested parser); guidle is a structured Swiss-wide
// events aggregator (reliable schema, broad coverage); myswitzerland is a
// tourism-board catalog (good imagery, but skews toward touristy/generic
// listings over hyper-local ones) — lowest priority of the three. Any future
// source not listed here sorts last (lowest priority) rather than crashing.
const SOURCE_PRIORITY = ['tio-agenda', 'guidle', 'myswitzerland'];

function sourcePriorityRank(ev) {
  const key = ev.sourceKey || String(ev.id || '').split(':')[0];
  const idx = SOURCE_PRIORITY.indexOf(key);
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

/**
 * Pick the single best record out of a group of fuzzy-duplicate events:
 * highest richness score wins; ties broken by SOURCE_PRIORITY; any remaining
 * tie (same source, e.g. a future multi-slice source) is broken by the
 * lexicographically smaller id, so the result is deterministic run-to-run.
 */
export function pickRichestEvent(group) {
  return [...group].sort((a, b) => {
    const scoreDiff = eventRichnessScore(b) - eventRichnessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const prioDiff = sourcePriorityRank(a) - sourcePriorityRank(b);
    if (prioDiff !== 0) return prioDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

/**
 * Collapse fuzzy cross-source duplicates. Returns the deduped event list plus
 * how many records were merged away (for --stats reporting).
 *
 * Deliberately scoped to groups spanning >= 2 DISTINCT `sourceKey`s. A group
 * that collides on title+startDate+comune but comes entirely from a single
 * source is left untouched — e.g. two unrelated "Street Food" events on the
 * same day both region-resolved (low-confidence fallback) to the same
 * representative comune are a real, observed false-positive collision that
 * must not eat a genuine second event. Same-source id collisions are each
 * source's own responsibility (and are already deduped by the by-id merge
 * above); this pass only exists to catch the SAME physical event indexed
 * independently by two-or-more different crawlers.
 */
export function dedupeFuzzy(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = fuzzyDedupKey(ev);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const out = [];
  let mergedAway = 0;
  for (const group of groups.values()) {
    const distinctSources = new Set(group.map((ev) => ev.sourceKey || String(ev.id || '').split(':')[0]));
    if (group.length === 1 || distinctSources.size < 2) {
      out.push(...group);
      continue;
    }
    mergedAway += group.length - 1;
    out.push(pickRichestEvent(group));
  }
  return { events: out, mergedAway };
}

// ── Italian frontier comuni attachment ──────────────────────────────────
/**
 * Attach `italianFrontierComuni` to every event that has `geo` but doesn't
 * already carry the field (a crawler may already have computed it — never
 * redo that work). Mutates and returns the same array for convenience.
 */
export function attachItalianFrontierComuni(events) {
  let attached = 0;
  for (const ev of events) {
    if (!ev.geo || ev.italianFrontierComuni !== undefined) continue;
    const comuni = resolveItalianFrontierComuni(ev.geo);
    if (comuni.length) {
      ev.italianFrontierComuni = comuni;
      attached += 1;
    }
  }
  return attached;
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

  const merged = [...byId.values()].map(({ __ts, ...ev }) => ev);
  const { events: deduped, mergedAway } = dedupeFuzzy(merged);
  const frontierAttached = attachItalianFrontierComuni(deduped);

  const events = deduped.sort(
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
  return { events, slices: slices.length, mergedAway, frontierAttached };
}

function printStats(events, mergedAway, frontierAttached) {
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
  console.log(`cross-source fuzzy dedup: merged away ${mergedAway} duplicate(s)`);
  console.log(`italian frontier comuni attached: ${frontierAttached} event(s)`);
}

// Guard the CLI entry point so importing this module for its exported pure
// functions (dedupeFuzzy / pickRichestEvent / eventRichnessScore /
// attachItalianFrontierComuni — see tests/assemble-events-dedup.test.ts)
// never runs assemble() as an import side effect and overwrites the tracked
// data/events.json.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const { events, slices, mergedAway, frontierAttached } = assemble();
  console.log(`[assemble-events] merged ${slices} slice(s) → ${events.length} upcoming events (${mergedAway} cross-source dup(s) collapsed) → ${path.relative(process.cwd(), EVENTS_DATASET_PATH)}`);
  if (process.argv.includes('--stats')) printStats(events, mergedAway, frontierAttached);
}
