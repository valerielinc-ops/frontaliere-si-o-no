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
 *      survivors by `(normalized title, startDate, normalized comune)` and
 *      collapses a group down to the single richest record when either
 *      (a) it spans 2+ DISTINCT sources, or (b) it is a single-source group
 *      whose members ALSO carry near-identical `geo` coordinates (issue
 *      #3744: the same source can re-index its own event under a second raw
 *      id/URL) — see `dedupeFuzzy` below for the scoring/tie-break rule and
 *      geo tolerance. A same-source collision WITHOUT a geo match (e.g. two
 *      different events that happen to share a generic title and a
 *      low-confidence region-fallback comune) is left untouched — merging
 *      those would risk silently dropping a genuine event.
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

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENTS_SLICE_DIR,
  EVENTS_DATASET_PATH,
  isoDay,
  normalizeText,
  resolveItalianFrontierComuni,
  haversineKm,
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

// Same-source geo-match tolerance (issue #3744): a single crawler can emit
// two records for the SAME physical event under different objectIDs/URLs
// (observed: myswitzerland's "Heididorf Saisoneröffnung" indexed twice, same
// startDate/comune and EXACT geo, two different objectIDs). 50m is tight
// enough to only catch true re-indexing dupes — two genuinely different
// venues that happen to share a generic title/date/region-fallback comune
// are not normally 50m apart — while still tolerant of float rounding in the
// source coordinates.
const SAME_SOURCE_GEO_TOLERANCE_KM = 0.05;

function hasGeo(ev) {
  return (
    typeof ev?.geo?.lat === 'number' &&
    typeof ev?.geo?.lng === 'number' &&
    Number.isFinite(ev.geo.lat) &&
    Number.isFinite(ev.geo.lng)
  );
}

/**
 * Partition a same-`sourceKey` fuzzy-dedup group (already collided on
 * title+startDate+comune) into geo-match clusters — 2+ members MUTUALLY
 * within `SAME_SOURCE_GEO_TOLERANCE_KM` of every OTHER member of the same
 * cluster (a clique, not a chain) — plus the leftover singles (events with no
 * `geo`, or whose `geo` doesn't clique-match anyone else in the group).
 *
 * Deliberately a clique check (`cluster.every(...)`), not a "some existing
 * member is close enough" chain check: a chain check lets a cluster's
 * diameter grow past the tolerance transitively (e.g. A-B 45m, B-C 45m would
 * chain A-B-C together even though A-C is 90m, well past the ~50m same-venue
 * assumption) — exactly the false-positive risk this same-source path exists
 * to avoid (see `dedupeFuzzy` docstring below). Requiring every new member to
 * already be within tolerance of every current member keeps every accepted
 * cluster's own diameter bounded by `SAME_SOURCE_GEO_TOLERANCE_KM`.
 *
 * Reuses the shared `haversineKm` helper (scripts/lib/events-utils.mjs)
 * rather than re-implementing great-circle distance here (AGENTS.md §6).
 */
function clusterBySameGeo(group) {
  const withGeo = group.filter(hasGeo);
  const singles = group.filter((ev) => !hasGeo(ev));
  const clusters = [];
  const assigned = new Set();
  for (let i = 0; i < withGeo.length; i += 1) {
    if (assigned.has(i)) continue;
    const cluster = [withGeo[i]];
    assigned.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < withGeo.length; j += 1) {
        if (assigned.has(j)) continue;
        const withinToleranceOfEveryMember = cluster.every(
          (member) =>
            haversineKm(member.geo.lat, member.geo.lng, withGeo[j].geo.lat, withGeo[j].geo.lng) <=
            SAME_SOURCE_GEO_TOLERANCE_KM,
        );
        if (withinToleranceOfEveryMember) {
          cluster.push(withGeo[j]);
          assigned.add(j);
          grew = true;
        }
      }
    }
    if (cluster.length > 1) clusters.push(cluster);
    else singles.push(cluster[0]);
  }
  return { clusters, singles };
}

/**
 * Collapse fuzzy duplicates. Returns the deduped event list plus how many
 * records were merged away (for --stats reporting).
 *
 * Two collapse conditions on a title+startDate+comune group:
 *   - >= 2 DISTINCT `sourceKey`s (issue #3125) — the SAME physical event
 *     indexed independently by two-or-more different crawlers.
 *   - a single-source group whose members ALSO carry `geo` coordinates
 *     within `SAME_SOURCE_GEO_TOLERANCE_KM` of each other (issue #3744) —
 *     the same source re-indexed its own event under a second raw id/URL.
 *
 * A single-source group WITHOUT a geo match (e.g. two unrelated "Street
 * Food" events on the same day both region-resolved — low-confidence
 * fallback — to the same representative comune) is left untouched — a real,
 * observed false-positive collision that must not eat a genuine second
 * event. Geo is the only signal that discriminates a true same-source
 * duplicate from that false positive; events with no `geo` on either side
 * never collapse via this path (they may still collapse via the
 * cross-source condition above if applicable).
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
    if (group.length === 1) {
      out.push(...group);
      continue;
    }
    const distinctSources = new Set(group.map((ev) => ev.sourceKey || String(ev.id || '').split(':')[0]));
    if (distinctSources.size < 2) {
      const { clusters, singles } = clusterBySameGeo(group);
      for (const cluster of clusters) {
        mergedAway += cluster.length - 1;
        out.push(pickRichestEvent(cluster));
      }
      out.push(...singles);
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
  const json = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(EVENTS_DATASET_PATH, json, 'utf-8');

  // Second copy under public/, mirroring what compute-border-wait-averages.mjs
  // does for its own dataset and for the same reason (issue #4974 item 3).
  //
  // `data/` is not part of the deployed surface, so a consumer outside this repo
  // has no way to read events.json at all. The events digest article moved to the
  // articles repo with the rest of the generator, and it cannot reach into this
  // repo's checkout without inverting the one-way architecture the migration
  // exists to establish. Publishing the file is what makes that fetch possible;
  // the crawling itself stays here, because it is a site data pipeline (§0.2).
  // Derived from EVENTS_DATASET_PATH (…/data/events.json) rather than a second
  // root computation, so the two copies cannot drift apart if the layout moves.
  const publicPath = path.join(path.dirname(EVENTS_DATASET_PATH), '..', 'public', 'data', 'events.json');
  mkdirSync(path.dirname(publicPath), { recursive: true });
  writeFileSync(publicPath, json, 'utf-8');

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
