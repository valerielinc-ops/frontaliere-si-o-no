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
 *   3b. Superseded HTML twins: while `ge-agenda` (geneve.ch HTML) runs next
 *      to its licensed API replacement `openagenda`, a duplicate pair keeps
 *      the OpenAgenda record, also when the two date a running event
 *      differently, but only when a physical-location key agrees — see
 *      `SUPERSEDED_EVENT_SOURCES`/`dedupeSupersededTwins`.
 *   4. Italian frontier comuni geo-link (issue #3125): every assembled event
 *      that carries `geo` but has no `italianFrontierComuni` yet (a crawler
 *      may already have attached it) gets `resolveItalianFrontierComuni`
 *      applied and the result attached when non-empty. Nationwide sources
 *      only index Swiss-side events; this tags border-zone Swiss events with
 *      the nearby Italian comuni they are relevant to (a frontaliere living
 *      just across the border), it does NOT crawl Italian municipal sites.
 *   4b. Canton from coordinates (P9a): an event that reaches the assembler
 *      with an empty `canton` but with `geo` gets the canton whose official
 *      boundary contains the point (`cantonAtPoint`, offline, swisstopo
 *      polygons). Points abroad or ambiguous stay unattributed. An existing
 *      `canton` is never overwritten. The route change that follows (from
 *      the canton-neutral bucket to the canton hub) is recorded in
 *      `previousRoutes` by the history pass below, like any other move.
 *   5. Retain past events as an append-only SEO archive. Upcoming/past
 *      indexability is decided by the page builder, never by data deletion.
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
  loadEventsDataset,
  normalizeText,
  resolveItalianFrontierComuni,
  haversineKm,
  EVENT_PRICE_SOURCES,
  hasConfidentPrice,
} from './lib/events-utils.mjs';
import { preserveEventHistory, publishedEventRoutes } from './lib/events-retention.mjs';
import { cantonAtPoint } from './lib/swiss-canton-geo.mjs';
import { eventDateIssues } from './lib/events-date-quality.mjs';
import { assertNoPrivateEvents, isPrivateEventRecord } from './lib/private-event-sources.mjs';

function readSlices(sliceDir = EVENTS_SLICE_DIR) {
  if (!existsSync(sliceDir)) return [];
  return readdirSync(sliceDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(path.join(sliceDir, f), 'utf-8'));
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
const RICHNESS_FIELDS = ['description', 'imageUrl', 'price', 'address', 'geo', 'venue', 'endDate', 'organizer', 'performer'];

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
// openagenda comes before the catalog sources: it is data under an open
// licence (Licence Ouverte 2.0), so on a tie the licensed record wins.
const SOURCE_PRIORITY = ['tio-agenda', 'openagenda', 'guidle', 'myswitzerland'];

function eventSourceKey(ev) {
  return ev.sourceKey || String(ev.id || '').split(':')[0];
}

function sourcePriorityRank(ev) {
  const idx = SOURCE_PRIORITY.indexOf(eventSourceKey(ev));
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

/**
 * An HTML crawler kept running only until its licensed API twin has proved
 * itself in production: `ge-agenda` scrapes geneve.ch, whose agenda IS the
 * Ville de Genève OpenAgenda. While both run, a duplicate pair always keeps
 * the OpenAgenda record — richness and SOURCE_PRIORITY only decide among the
 * rest. Retiring `ge-agenda` (its crawl step) is a separate change; its slice
 * stays as an archive either way.
 */
export const SUPERSEDED_EVENT_SOURCES = Object.freeze({ 'ge-agenda': 'openagenda' });

function isSupersededIn(ev, groupSources) {
  const replacement = SUPERSEDED_EVENT_SOURCES[eventSourceKey(ev)];
  return Boolean(replacement && groupSources.has(replacement));
}

function knownPrice(price) {
  const amount = price?.isFree === true ? 0 : price?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
  return { amount, currency: price.currency || 'CHF', isFree: amount === 0 };
}

const PRICE_PROVENANCE_FIELDS = ['priceSource', 'priceField'];

function priceProvenance(price) {
  return Object.fromEntries(PRICE_PROVENANCE_FIELDS.filter((field) => price?.[field]).map((field) => [field, price[field]]));
}

function withoutPriceProvenance(price) {
  if (!price || typeof price !== 'object') return price;
  return Object.fromEntries(Object.entries(price).filter(([key]) => (
    !PRICE_PROVENANCE_FIELDS.includes(key) && key !== 'priceConflicts'
  )));
}

function samePrice(a, b) {
  return a.amount === b.amount && a.currency === b.currency;
}

/**
 * The reliable tariff of a fuzzy-duplicate group, by source precedence
 * (EVENT_PRICE_SOURCES: MySwitzerland before Guidle), plus every other known
 * duplicate tariff that disagrees with it. Only structured source fields
 * (`hasConfidentPrice`) can be chosen; a disagreeing text tariff is still
 * recorded as a conflict, never silently dropped.
 */
function structuredGroupPrice(group) {
  const ranked = group
    .filter((event) => hasConfidentPrice(event.price) && knownPrice(event.price))
    .sort((a, b) => (
      EVENT_PRICE_SOURCES.indexOf(a.price.priceSource) - EVENT_PRICE_SOURCES.indexOf(b.price.priceSource)
      || String(a.id).localeCompare(String(b.id))
    ));
  if (!ranked.length) return undefined;
  const chosen = ranked[0];
  const value = knownPrice(chosen.price);
  const conflicts = group
    .filter((event) => event !== chosen && knownPrice(event.price) && !samePrice(knownPrice(event.price), value))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((event) => ({ eventId: event.id, ...knownPrice(event.price), ...priceProvenance(event.price) }));
  return { chosen, value: { ...value, ...priceProvenance(chosen.price) }, conflicts };
}

/**
 * Pick the single best record out of a group of fuzzy-duplicate events:
 * a record whose source is superseded by another source of the same group
 * (SUPERSEDED_EVENT_SOURCES) never wins; then the
 * highest richness score wins; ties broken by SOURCE_PRIORITY; any remaining
 * tie (same source, e.g. a future multi-slice source) is broken by the
 * lexicographically smaller id, so the result is deterministic run-to-run.
 * The tariff follows the owner's source precedence (2026-10-04): a structured
 * MySwitzerland, then Guidle, price of any duplicate replaces the winner's
 * price as a whole (amount and that record's own Offer metadata), and
 * disagreeing duplicate tariffs are kept in `price.priceConflicts`.
 * Without a structured price, a missing tariff is recovered only when the
 * known prices of its duplicates agree. Neither path changes the winner's
 * identity.
 */
export function pickRichestEvent(group) {
  const groupSources = new Set(group.map(eventSourceKey));
  const winner = [...group].sort((a, b) => {
    const supersededDiff = Number(isSupersededIn(a, groupSources)) - Number(isSupersededIn(b, groupSources));
    if (supersededDiff !== 0) return supersededDiff;
    const scoreDiff = eventRichnessScore(b) - eventRichnessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    const prioDiff = sourcePriorityRank(a) - sourcePriorityRank(b);
    if (prioDiff !== 0) return prioDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];
  // A structured MySwitzerland/Guidle tariff wins over any other duplicate
  // price, the winner's own included; a disagreement is recorded on the price.
  const structured = structuredGroupPrice(group);
  const prices = group.map((event) => knownPrice(event.price)).filter(Boolean);
  const agreedPrice = prices.length && prices.every((price) => samePrice(price, prices[0])) ? prices[0] : undefined;
  let enrichedWinner = winner;
  if (structured && !(structured.chosen === winner && !structured.conflicts.length)) {
    // The whole Offer comes from the chosen record: its ticket url,
    // availability, validFrom and evidence describe that value. The winner's
    // own ticketing metadata belongs to a price that lost (or was absent), so
    // pairing it with the chosen amount would publish a mixed Offer.
    enrichedWinner = {
      ...winner,
      price: {
        ...withoutPriceProvenance(structured.chosen.price),
        ...structured.value,
        ...(structured.conflicts.length ? { priceConflicts: structured.conflicts } : {}),
      },
    };
  } else if (!structured && !knownPrice(winner.price) && agreedPrice) {
    // No reliable tariff: carry the agreed value with the provenance of the
    // record it came from, so a text tariff never looks structured.
    const donor = group.find((event) => knownPrice(event.price));
    enrichedWinner = {
      ...winner,
      price: { ...withoutPriceProvenance(winner.price), ...agreedPrice, ...priceProvenance(donor.price) },
    };
  }
  // Fuzzy duplicates have different stable ids and may not describe the same
  // URL namespace (one can be comune-less). Carry only explicit history from
  // those records; the current route of a discarded duplicate is not safe to
  // reconstruct without a persisted canton/comune route.
  const historicalOnly = group
    .filter((event) => event !== winner && Array.isArray(event.previousRoutes))
    .map((event) => ({ previousRoutes: event.previousRoutes }));
  return preserveEventHistory(enrichedWinner, historicalOnly);
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

function dateCoveredBy(day, ev) {
  return typeof day === 'string' && day >= ev.startDate && day <= (ev.endDate || ev.startDate);
}

function normalizeLocationPart(value) {
  if (typeof value !== 'string') return '';
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Physical-location dimensions shared by the event sources. A missing
 * dimension is unknown, not a wildcard: only dimensions present on both
 * records may establish a match, and conflicting shared dimensions reject it.
 * This keeps a same-title/same-comune event at another venue from being
 * swallowed by the superseded-source rule.
 */
function physicalLocationKey(event) {
  const venue = normalizeLocationPart(event?.venue);
  const address = event?.address && typeof event.address === 'object' ? event.address : {};
  const street = normalizeLocationPart(address.street || (typeof event?.address === 'string' ? event.address : ''));
  const postalCode = normalizeLocationPart(address.postalCode);
  const locality = normalizeLocationPart(address.locality);
  const lat = typeof event?.geo?.lat === 'number' && Number.isFinite(event.geo.lat)
    ? event.geo.lat.toFixed(6)
    : '';
  const lng = typeof event?.geo?.lng === 'number' && Number.isFinite(event.geo.lng)
    ? event.geo.lng.toFixed(6)
    : '';
  const geo = lat && lng ? `${lat},${lng}` : '';
  return { venue, street, postalCode, locality, geo };
}

function samePhysicalLocation(left, right) {
  const a = physicalLocationKey(left);
  const b = physicalLocationKey(right);
  const dimensions = ['venue', 'street', 'postalCode', 'locality', 'geo'].filter(
    (dimension) => a[dimension] && b[dimension],
  );
  return dimensions.length > 0 && dimensions.every((dimension) => a[dimension] === b[dimension]);
}

/**
 * Second pass for SUPERSEDED_EVENT_SOURCES, after `dedupeFuzzy`: the HTML
 * twin and its API replacement describe the same event with the same title in
 * the same comune and physical location, but not always with the same
 * `startDate` — geneve.ch prints «jusqu'au 25 octobre» for a running
 * exhibition, which ge-agenda dates from the crawl day, while OpenAgenda
 * dates it from its first timing. A superseded record collapses into the ONE
 * replacement record whose date range covers its start; with no location key
 * or zero/several candidates it is left alone, since an ambiguous match could
 * eat a genuine second event.
 */
export function dedupeSupersededTwins(events) {
  const replacementsByKey = new Map();
  for (const ev of events) {
    if (!Object.values(SUPERSEDED_EVENT_SOURCES).includes(eventSourceKey(ev))) continue;
    const key = `${eventSourceKey(ev)}|${normalizeText(ev.title)}|${normalizeText(ev.comune || '')}`;
    if (!replacementsByKey.has(key)) replacementsByKey.set(key, []);
    replacementsByKey.get(key).push(ev);
  }
  const absorbed = new Map();
  const dropped = new Set();
  for (const ev of events) {
    const replacementSource = SUPERSEDED_EVENT_SOURCES[eventSourceKey(ev)];
    if (!replacementSource) continue;
    const key = `${replacementSource}|${normalizeText(ev.title)}|${normalizeText(ev.comune || '')}`;
    const candidates = (replacementsByKey.get(key) || []).filter(
      (candidate) => dateCoveredBy(ev.startDate, candidate) && samePhysicalLocation(ev, candidate),
    );
    if (candidates.length !== 1) continue;
    const [replacement] = candidates;
    if (!absorbed.has(replacement)) absorbed.set(replacement, []);
    absorbed.get(replacement).push(ev);
    dropped.add(ev);
  }
  if (!dropped.size) return { events, mergedAway: 0 };
  const out = [];
  for (const ev of events) {
    if (dropped.has(ev)) continue;
    const twins = absorbed.get(ev);
    if (!twins) {
      out.push(ev);
      continue;
    }
    // Pick the OpenAgenda replacement using the normal richness/source rules,
    // but merge route history explicitly from every dropped ge-agenda twin.
    // The picker receives history-free candidates so it cannot turn a dropped
    // record's route into an implicit current-route fallback.
    const candidates = [ev, ...twins].map((candidate) => {
      if (!Array.isArray(candidate.previousRoutes)) return candidate;
      const { previousRoutes: _previousRoutes, ...withoutHistory } = candidate;
      return withoutHistory;
    });
    const replacement = pickRichestEvent(candidates);
    const previousRoutes = [ev, ...twins].flatMap((candidate) => (
      Array.isArray(candidate.previousRoutes) ? candidate.previousRoutes : []
    ));
    out.push(previousRoutes.length
      ? preserveEventHistory({ ...replacement, previousRoutes }, [])
      : replacement);
  }
  return { events: out, mergedAway: dropped.size };
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

// ── Canton from coordinates ─────────────────────────────────────────────
/**
 * Fill an empty `canton` from `geo` with the canton whose official boundary
 * contains the point. Mutates `events` in place; returns how many events got
 * a canton. Never touches an event that already has one, and leaves `comune`
 * alone (a canton polygon says nothing about the municipality). `cantonAt` is
 * injectable for tests.
 */
export function attachCantonFromGeo(events, cantonAt = cantonAtPoint) {
  let attached = 0;
  for (const ev of events) {
    if (typeof ev.canton === 'string' && ev.canton.trim()) continue;
    if (!ev.geo) continue;
    const canton = cantonAt(ev.geo);
    if (!canton) continue;
    ev.canton = canton;
    attached += 1;
  }
  return attached;
}

/**
 * Paths are injectable only so tests can assemble into a temp dir
 * (tests/events-private-source-exclusions.test.ts); the CLI uses the defaults.
 */
export function assemble({ sliceDir = EVENTS_SLICE_DIR, datasetPath = EVENTS_DATASET_PATH } = {}) {
  const priorDataset = loadEventsDataset(datasetPath);
  const priorById = new Map(priorDataset.events.map((event) => [event.id, event]));
  const priorRoutes = publishedEventRoutes(priorDataset.events, priorDataset.generatedAt?.slice(0, 10));
  const slices = readSlices(sliceDir);
  const byId = new Map();
  let invalidRecords = 0;
  let privateRecords = 0;

  for (const slice of slices) {
    const sliceTs = Date.parse(slice.assembledAt || '') || 0;
    for (const ev of slice.events) {
      if (!ev || !ev.id || !ev.startDate || !ev.title) continue;
      // Eventfrog & co. (scripts/lib/private-event-sources.mjs): a record of a
      // private source must never reach data/events.json or its public copy,
      // which the corpus republishes as an open API (AGB §17(3)).
      if (isPrivateEventRecord(ev)) {
        privateRecords += 1;
        continue;
      }
      const dateIssues = eventDateIssues(ev);
      if (dateIssues.length > 0) {
        invalidRecords += 1;
        console.warn(`[assemble-events] skipping ${ev.id}: ${dateIssues.join(', ')}`);
        continue;
      }
      const prev = byId.get(ev.id);
      if (!prev || sliceTs >= (prev.__ts || 0)) {
        const merged = prev ? preserveEventHistory(ev, [prev]) : ev;
        byId.set(ev.id, { ...merged, __ts: sliceTs });
      }
    }
  }

  const merged = [...byId.values()].map(({ __ts, ...ev }) => ev);
  const fuzzy = dedupeFuzzy(merged);
  const twins = dedupeSupersededTwins(fuzzy.events);
  const deduped = twins.events;
  const mergedAway = fuzzy.mergedAway + twins.mergedAway;
  const cantonlessBefore = deduped.filter((event) => !(typeof event.canton === 'string' && event.canton.trim())).length;
  const cantonFromGeo = attachCantonFromGeo(deduped);
  const frontierAttached = attachItalianFrontierComuni(deduped);
  const withHistory = deduped.map((event) => {
    const prior = priorById.get(event.id);
    const priorRoute = priorRoutes.get(event.id);
    if (!prior || !priorRoute) return event;
    return preserveEventHistory(event, [{
      ...prior,
      __historySlug: priorRoute.slug,
      __historyCanton: priorRoute.canton,
      __historyComune: priorRoute.comune,
    }]);
  });

  const events = withHistory.sort(
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
  // Second line of defense: the prior dataset is read back above, so a record
  // that leaked into it once must not be carried forward either.
  assertNoPrivateEvents(events, 'data/events.json and public/data/events.json');
  if (privateRecords > 0) console.warn(`[assemble-events] dropped ${privateRecords} private-source record(s) found in public slices`);
  const json = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(datasetPath, json, 'utf-8');

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
  const publicPath = path.join(path.dirname(datasetPath), '..', 'public', 'data', 'events.json');
  mkdirSync(path.dirname(publicPath), { recursive: true });
  writeFileSync(publicPath, json, 'utf-8');

  return {
    events,
    slices: slices.length,
    mergedAway,
    frontierAttached,
    invalidRecords,
    privateRecords,
    publicPath,
    cantonless: { before: cantonlessBefore, fromGeo: cantonFromGeo },
  };
}

function printStats(events, mergedAway, frontierAttached, cantonless) {
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
  console.log(`canton from coordinates: ${cantonless.fromGeo} of ${cantonless.before} canton-less event(s) attributed — ${cantonless.before - cantonless.fromGeo} still without canton`);
  const priceFields = new Map();
  let reliablePrices = 0;
  let priceConflicts = 0;
  for (const e of events) {
    if (!e.price || (e.price.amount == null && e.price.isFree !== true)) continue;
    const key = `${e.price.priceSource || 'unsourced'}/${e.price.priceField || 'unknown'}`;
    priceFields.set(key, (priceFields.get(key) || 0) + 1);
    if (hasConfidentPrice(e.price)) reliablePrices += 1;
    if (Array.isArray(e.price.priceConflicts) && e.price.priceConflicts.length) priceConflicts += 1;
  }
  console.log(`prices: ${reliablePrices} reliable (structured source field) | conflicts recorded: ${priceConflicts}`);
  console.log(`price provenance: ${[...priceFields.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).join(', ')}`);
}

// Guard the CLI entry point so importing this module for its exported pure
// functions (dedupeFuzzy / pickRichestEvent / eventRichnessScore /
// attachItalianFrontierComuni / attachCantonFromGeo — see
// tests/assemble-events-dedup.test.ts)
// never runs assemble() as an import side effect and overwrites the tracked
// data/events.json.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const { events, slices, mergedAway, frontierAttached, invalidRecords, cantonless } = assemble();
  console.log(`[assemble-events] merged ${slices} slice(s) → ${events.length} retained events (${mergedAway} cross-source dup(s) collapsed; ${invalidRecords} invalid date record(s) skipped) → ${path.relative(process.cwd(), EVENTS_DATASET_PATH)}`);
  if (process.argv.includes('--stats')) printStats(events, mergedAway, frontierAttached, cantonless);
}
