#!/usr/bin/env node
/**
 * Crawler — MySwitzerland (Switzerland Tourism nationwide events, issue #3125).
 *
 * MySwitzerland's public event search UI (https://www.myswitzerland.com/it-ch/
 * scoprire-la-svizzera/manifestazioni/manifestazioni-ricerca/) runs against an
 * Algolia search index. The app id + a READ-ONLY, search-only API key are baked
 * into the page's inline JS config (`algolia: { app, key, index, ... }`) — this
 * is the exact same public data every visitor's browser already loads to render
 * the search results, so querying it directly with plain `fetch` is legitimate
 * content aggregation, not evasion. Verified live 2026-07-02:
 *   - app "LMQVZQEU2J", one index per locale: myst_it-CH / myst_en-CH /
 *     myst_de-CH / myst_fr-CH (all four confirmed live, near-identical counts).
 *   - the `browse` endpoint (cursor-based, uncapped) is 403 for this key
 *     ("missing ACL \"browse\""), and any single `query` call is hard-capped at
 *     1000 reachable results (page*hitsPerPage <= 1000) — confirmed live. Full
 *     enumeration therefore recursively bisects the numeric `updatedTimestamp`
 *     attribute into <=1000-hit buckets (see `enumerateEventsForLocale`).
 *   - the search index gives id/title/description/dates/geo/image/place per
 *     locale, plus source-language attribution copy in `content`; price,
 *     structured address and category exist in the schema.org Event JSON-LD
 *     and, for price, the localized detail table on each event's own page.
 *     We fetch the first usable detail page per unique event and continue
 *     across locale URLs only when optional metadata is still missing.
 *   - `objectID` is stable across all 4 locale indices for the same event, so
 *     the 4 locale searches are unioned by id to build titleByLocale /
 *     descriptionByLocale (real per-locale translations, not machine ones).
 *
 * Respectful, non-evasive crawling: plain `fetch`, no headless browser, no
 * TLS/header spoofing, a clearly identifying User-Agent (matches the tio-agenda
 * / mirrorEventImage convention), and a politeness delay between requests to
 * both Algolia and the myswitzerland.com origin. Every event image is mirrored
 * once via `mirrorEventImage` (see scripts/lib/events-utils.mjs) — the output
 * slice NEVER references a myswitzerland.com/cloudfront image URL directly.
 *
 * No artificial cap: the full catalog (tens of thousands of records across
 * ~20 Algolia buckets x 4 locales, then one detail-page fetch per unique
 * event) is walked across MANY scheduled runs, not one. Index enumeration
 * (bounded, ~dozens-to-hundreds of Algolia calls) still runs in full every
 * time, but the slow part — one detail-page fetch per unique event — is
 * bounded per run by MYSWITZERLAND_CRAWL_BUDGET_MS (default 8 minutes, well
 * inside crawl-events.yml's shared 35-minute job timeout): each run walks a
 * slice of the enumerated records starting at a persisted cursor
 * (data/events/checkpoints/myswitzerland.json, see
 * scripts/lib/crawl-checkpoint.mjs) and wraps back to the start once the
 * whole catalog has been visited. Each run MERGES what it found into the
 * existing on-disk slice instead of overwriting it wholesale, so a run that
 * stops at its time budget never loses prior runs' progress — coverage of
 * the full catalog accrues over many scheduled runs (issue #3125: "no pilot
 * batch, must be complete" — no permanent cap on total events ever
 * crawled). Same design used for crawl-guidle-events.mjs.
 *
 * Usage:
 *   node scripts/crawl-myswitzerland-events.mjs                # one time-budgeted, checkpointed slice of the catalog
 *   node scripts/crawl-myswitzerland-events.mjs --limit=5      # fast local test (bypasses the checkpoint)
 *   node scripts/crawl-myswitzerland-events.mjs --ids=<id,id> # revisit selected catalog records with a separate checkpoint
 *   node scripts/crawl-myswitzerland-events.mjs --dry-run      # parse + report, no write
 *
 * Exit code is always 0 unless an unexpected crash occurs, EXCEPT when Algolia
 * queries succeed but yield zero events (index/key/facet drift) — that exits 1
 * so crawl-events.yml can open a failure issue instead of the dataset going
 * silently stale (same soft/hard-fail distinction as crawl-tio-agenda.mjs).
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  eventStableId,
  resolveComuneNationwide,
  resolveItalianFrontierComuni,
  mirrorEventImage,
  cleanEventText,
  loadEventTitleTranslationCache,
  saveEventTitleTranslationCache,
  enrichEventsWithLocaleFallbackTranslations,
  loadGeocodeCache,
  saveGeocodeCache,
  enrichEventsWithGeoComune,
  hasConfidentPrice,
  hasParsedPrice,
  withEventPriceSource,
} from './lib/events-utils.mjs';
import { CHECKPOINT_DIR, loadCursor, saveCursor, loadGenericCursor, saveGenericCursor, mergeEventsIntoSlice } from './lib/crawl-checkpoint.mjs';
import { fetchEventBookingPrice, sameVenue, supportedEventBookingUrl } from './lib/event-booking-price.mjs';
import {
  extractDetailContactName,
  extractDetailTableValue,
  extractEventPeopleFromText,
  extractEventPeopleFromTitle,
  extractEventOfferMetadata,
  extractStructuredEventPrice,
  parseEventPriceText,
  firstEventImageUrl,
  firstEventImageUrlFromHtml,
  fillEventPeopleDefaults,
  hasCompleteEventPeopleUrls,
  mergeEventOfferMetadata,
  mergeEventPeopleUrls,
  normalizeEventPeople,
} from './lib/event-metadata.mjs';

// Kept as a crawler export for existing callers/tests; the implementation is
// shared with contact/image extraction in lib/event-metadata.mjs.
export { extractDetailTableValue } from './lib/event-metadata.mjs';

const SOURCE = EVENT_SOURCES.myswitzerland;

// Public, read-only Algolia search credentials for the MySwitzerland event
// search UI — NOT a secret (see header comment). No admin/write/browse ACL.
const ALGOLIA_APP_ID = 'LMQVZQEU2J';
const ALGOLIA_SEARCH_KEY = '913f352bafbf1fcb6735609f39cc7399';
const ALGOLIA_HOST = `https://${ALGOLIA_APP_ID}-dsn.algolia.net`;
const ALGOLIA_PAGE_CAP = 1000; // Algolia's hard per-query pagination cap (verified live)

const LOCALES = ['it', 'en', 'de', 'fr'];
const LOCALE_INDEX = { it: 'myst_it-CH', en: 'myst_en-CH', de: 'myst_de-CH', fr: 'myst_fr-CH' };
const LOCALE_URL_PREFIX = { it: 'it-ch', en: 'en-ch', de: 'de-ch', fr: 'fr-ch' };
const SITE_ORIGIN = 'https://www.myswitzerland.com';

const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const FETCH_TIMEOUT_MS = 20000;
const ALGOLIA_DELAY_MS = 120; // between Algolia queries (index enumeration)
const DETAIL_DELAY_MS = 500; // between myswitzerland.com origin detail-page fetches
const RUN_BUDGET_MS = Number(process.env.MYSWITZERLAND_CRAWL_BUDGET_MS) || 8 * 60_000; // per-run wall-clock cap
// Caps the locale-fallback translation pass that runs AFTER the visit loop.
// RUN_BUDGET_MS never covered it, so the process routinely outlived its stated
// budget by ~18min and was killed by crawl-events.yml's timeout-minutes before
// it could save the checkpoint or the slice — see the note on
// enrichEventsWithLocaleFallbackTranslations in lib/events-utils.mjs.
const TRANSLATE_BUDGET_MS = Number(process.env.MYSWITZERLAND_TRANSLATE_BUDGET_MS) || 4 * 60_000;
// Same shape for the geo → comune/canton fallback pass (issue #7328), which is
// also AFTER the visit loop and also paced (≤1 Nominatim req/s): 1205 of the
// 1235 unattributed events are myswitzerland's, so a first pass drains its
// share of the backlog over a few nightly runs against a warming disk cache
// instead of blowing crawl-events.yml's timeout-minutes in one go.
const GEO_COMUNE_BUDGET_MS = Number(process.env.MYSWITZERLAND_GEO_COMUNE_BUDGET_MS) || 4 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let algoliaFailures = 0;

async function algoliaQuery(index, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${ALGOLIA_HOST}/1/indexes/${index}/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'X-Algolia-API-Key': ALGOLIA_SEARCH_KEY,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      algoliaFailures += 1;
      return null;
    }
    return await res.json();
  } catch {
    algoliaFailures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enumerate ALL "Event"-type records in one locale index via recursive
 * numeric bisection on `updatedTimestamp`. A single Algolia query cannot
 * reach past 1000 results (verified live) and this key has no `browse` ACL
 * (also verified live, 403), so a flat paginated walk cannot cover the full
 * ~19-20k catalog. Instead we recursively halve the timestamp range until
 * each leaf bucket has <=1000 hits, then fetch that leaf in one page. Cheap
 * `hitsPerPage:0` count-only calls drive the recursion.
 *
 * Caveat: this is a live, actively-edited production index — a record whose
 * `updatedTimestamp` shifts mid-crawl can in theory be counted by two leaves
 * or missed by all of them. Downstream dedup is by `objectID` (a Map), so a
 * double-count is harmless; a rare miss self-heals on the next scheduled
 * crawl. Empirically verified live: a real disjoint left/right split had ZERO
 * objectID overlap — observed total-count drift across a full multi-minute
 * bisection came from live data churn, not a boundary bug.
 */
async function enumerateEventsForLocale(index) {
  const byId = new Map();
  const hi = Math.floor(Date.now() / 1000) + 30 * 86400;

  async function leaf(lo, hiBound) {
    const counted = await algoliaQuery(index, {
      query: '',
      hitsPerPage: 0,
      facetFilters: [['type:Event']],
      numericFilters: [`updatedTimestamp>=${lo}`, `updatedTimestamp<${hiBound}`],
    });
    await sleep(ALGOLIA_DELAY_MS);
    const nbHits = counted?.nbHits ?? 0;
    if (nbHits === 0) return;

    if (nbHits <= ALGOLIA_PAGE_CAP || hiBound - lo <= 1) {
      const page = await algoliaQuery(index, {
        query: '',
        hitsPerPage: ALGOLIA_PAGE_CAP,
        facetFilters: [['type:Event']],
        numericFilters: [`updatedTimestamp>=${lo}`, `updatedTimestamp<${hiBound}`],
      });
      await sleep(ALGOLIA_DELAY_MS);
      const hits = page?.hits ?? [];
      if (hits.length < nbHits) {
        console.warn(
          `[myswitzerland] ${index}: indivisible bucket [${lo},${hiBound}) has ${nbHits} hits but the ` +
            `1000-per-query cap only returned ${hits.length} — some events in this bucket are skipped this run`,
        );
      }
      for (const h of hits) if (h?.objectID) byId.set(h.objectID, h);
      return;
    }

    const mid = Math.floor((lo + hiBound) / 2);
    await leaf(lo, mid);
    await leaf(mid, hiBound);
  }

  await leaf(0, hi);
  return byId;
}

/** Fast, non-exhaustive variant for `--limit` local iteration: one page, no bisection. */
async function enumerateEventsForLocaleLimited(index, limit) {
  const byId = new Map();
  const page = await algoliaQuery(index, {
    query: '',
    hitsPerPage: Math.min(Math.max(limit, 1), ALGOLIA_PAGE_CAP),
    facetFilters: [['type:Event']],
  });
  for (const h of page?.hits ?? []) if (h?.objectID) byId.set(h.objectID, h);
  return byId;
}

/** Group per-locale hit maps by shared `objectID` (stable across locale indices). */
function groupHitsByObjectId(localeMaps) {
  const allIds = new Set();
  for (const locale of LOCALES) for (const id of localeMaps[locale].keys()) allIds.add(id);
  const out = [];
  for (const id of allIds) {
    const perLocaleHits = {};
    for (const locale of LOCALES) {
      const hit = localeMaps[locale].get(id);
      if (hit) perLocaleHits[locale] = hit;
    }
    out.push({ objectID: id, perLocaleHits });
  }
  return out;
}

const COMPACT_UTC_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** "20260704T173000Z" (Algolia's compact UTC format) → Date, or null. */
export function parseCompactUtc(compact) {
  const m = COMPACT_UTC_RE.exec(String(compact || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/** Europe/Zurich local {date:'YYYY-MM-DD', time:'HH:MM'} for a UTC instant. */
export function zurichParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Extract {startDate, startTime, endDate, recurring} from an Algolia hit's
 * `applicableDates.rules[].conditions.{from,to}` (each a real UTC instant —
 * verified live against the same event's naive-local JSON-LD startDate/
 * endDate, which matched exactly once converted to Europe/Zurich). Falls back
 * to `executionDates` (unix seconds) when no rules are present. Multiple
 * rules/executionDates ⇒ a recurring event (multiple real occurrences).
 * Returns null when the hit has no usable date at all (dropped by the caller
 * — `startDate` is required downstream).
 */
export function extractDateInfo(hit) {
  const rules = Array.isArray(hit?.applicableDates?.rules) ? hit.applicableDates.rules : [];
  const starts = [];
  const ends = [];
  for (const rule of rules) {
    const from = parseCompactUtc(rule?.conditions?.from);
    const to = parseCompactUtc(rule?.conditions?.to);
    if (from) starts.push(from);
    if (to) ends.push(to);
    else if (from) ends.push(from);
  }
  if (!starts.length && Array.isArray(hit?.executionDates)) {
    for (const ts of hit.executionDates) {
      if (typeof ts === 'number' && Number.isFinite(ts)) starts.push(new Date(ts * 1000));
    }
  }
  if (!starts.length) return null;

  starts.sort((a, b) => a - b);
  const first = starts[0];
  const last = ends.length ? ends.sort((a, b) => a - b)[ends.length - 1] : starts[starts.length - 1];

  const startParts = zurichParts(first);
  const endParts = zurichParts(last);
  const occurrences = Math.max(rules.length, Array.isArray(hit?.executionDates) ? hit.executionDates.length : 0, 1);

  return {
    startDate: startParts.date,
    startTime: startParts.time,
    endDate: endParts.date,
    recurring: occurrences > 1,
  };
}

function cleanText(value) {
  return cleanEventText(value);
}

function extractGeo(hit) {
  const g = hit?._geoloc;
  if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number') return undefined;
  return { lat: g.lat, lng: g.lng };
}

/** Humanize a schema.org Event @type ("MusicEvent" → "Music", "Festival" → "Festival"). */
export function humanizeCategory(rawType) {
  if (typeof rawType !== 'string' || !rawType.trim()) return undefined;
  const stripped = rawType.replace(/Event$/, '').trim();
  const base = stripped || rawType;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || 'Event';
}

/**
 * Price from JSON-LD `isAccessibleForFree`/`offers` (structured, reliable), or
 * else the localized detail table (tariff text, recorded but not reliable).
 */
export function extractPrice(ld, detailHtml, detailUrl) {
  const structured = extractStructuredEventPrice(ld, detailUrl || SITE_ORIGIN, SOURCE.key);
  if (structured) return structured;
  const offerMetadata = extractEventOfferMetadata(ld?.offers, detailUrl || SITE_ORIGIN) || {};
  const tablePrice = extractDetailTableValue(detailHtml, ['Prezzo', 'Preis', 'Price', 'Prix']);
  if (tablePrice) {
    const price = parseEventPriceText(tablePrice);
    if (hasParsedPrice(price)) return withEventPriceSource({ ...price, ...offerMetadata }, SOURCE.key, 'detail-table');
  }
  return undefined;
}

/**
 * The public search index appends some admission tariffs to event content.
 * Recover a terminal free-admission statement or one explicitly labelled
 * monetary tariff. Ancillary amounts and conditional ticket prices are not
 * evidence of the event's general admission price.
 */
export function extractIndexedEventPrice(content) {
  if (typeof content !== 'string') return undefined;
  const freeTariff = /(?:^|[.!?\n])\s*(?:gratuit[oea]?|kostenlos|gratis|free)\s*[.!]?\s*$/iu.test(content)
    || /(?:^|[.!?\n,])\s*(?:(?:prices?|preis|prix|prezzo)\s*:\s*)?(?:free\s+(?:admission|entry|entrance)|(?:admission|entry|entrance)(?:\s*:\s*|\s+(?:is\s+)?)free|(?:eintritt|entrée|ingresso|entrata)\s*:?[ \t]*(?:frei|liber[oa]|libre|gratuit[oea]?|kostenlos|gratis))\s*[.!]?\s*$/iu.test(content);
  if (freeTariff) return withEventPriceSource({ amount: 0, currency: 'CHF', isFree: true }, SOURCE.key, 'index-content');

  // Index content can concatenate adjacent HTML blocks ("buffetPrice:").
  // Require a field boundary or that exact concatenation, not "parking price".
  const tariffs = [...content.matchAll(/(?:^\s*|[.!?\n•"“]\s*|(?<=\bbuffet)(?=Price\s*:))(?:(?:prices?|preis|prix|prezzo)\s*:|(?:single\s+admission\s+price|admission|entry|entrance|eintritt|entrée|ingresso)\s*:?)\s*((?:CHF|EUR|€)\s*\d+(?:[.,]\d{1,2})?(?:[.,][-–—]{1,2})?(?!\d|[.,'’]\d)|\d+(?:[.,]\d{1,2})?(?:[.,][-–—]{1,2})?\s*(?:(?:CHF|EUR)\b|€))/giu)];
  if (tariffs.length !== 1) return undefined;
  const tariff = tariffs[0];
  const qualifier = content.slice(tariff.index + tariff[0].length)
    .replace(/^[\s,;:.!?–—\-"'“”‘’«»\[\]{}]+/u, '')
    .replace(/^\s*(?:(?:for\s+)?(?:the\s+)?adults?\s+and\s+(?:the\s+)?children|(?:für\s+)?(?:die\s+)?erwachsenen?\s+und\s+(?:die\s+)?kinder|(?:pour\s+)?(?:les\s+)?adultes\s+et\s+(?:les\s+)?enfants|(?:per\s+)?(?:(?:gli|i)\s+)?adulti\s+e\s+(?:i\s+)?bambini)\b/iu, '')
    .replace(/^\s*(?:per\s+(?:person|persona)|pro\s+Person|par\s+personne|for\s+everyone)\b/iu, '');
  if (/^\s*(?:[+/%(]|(?:CHF|EUR|€)\s*\d|(?:deposit|supplement|surcharge|anzahlung|zuschlag|acompte|caparra)\b|(?:for|für|pour|per)\s+\p{L}|(?:(?:the|les|le|gli|i|die|den)\s+)?(?:members?|adults?|adult[ei]|adultes?|erwachsenen?|children|kids|students?|kinder|mitglieder|bambini|soci|enfants|membres|famil(?:y|ies|ien|les)|famigli[ae]|reduced|discounted|ermässigt|ridotto|réduit)\b|(?:mit|avec|con)\s+(?:gästekarte|carte|carta)\b)/iu.test(qualifier)) return undefined;
  const price = parseEventPriceText(tariff[1]);
  return hasParsedPrice(price)
    ? withEventPriceSource({ ...price, currency: /EUR|€/iu.test(tariff[1]) ? 'EUR' : 'CHF' }, SOURCE.key, 'index-content')
    : undefined;
}

/** Fill existing unknown prices from the index independently of the detail cursor. */
export function recoverExistingIndexedPrices(existingEvents, records) {
  const pricesById = new Map(records.map(({ objectID, perLocaleHits }) => [
    eventStableId(SOURCE.key, objectID),
    LOCALES.map((locale) => extractIndexedEventPrice(perLocaleHits[locale]?.content)).find(hasParsedPrice),
  ]));
  return existingEvents.flatMap((event) => {
    if (hasParsedPrice(event.price)) return [];
    const price = pricesById.get(event.id);
    return price ? [{ ...event, price: { ...event.price, ...price } }] : [];
  });
}

/** Retain verified price metadata while a targeted/detail refresh rebuilds selected events. */
export function recoverExistingKnownPrices(existingEvents, records) {
  const selectedIds = new Set(records.map(({ objectID }) => eventStableId(SOURCE.key, objectID)));
  return existingEvents.flatMap((event) => {
    if (!selectedIds.has(event.id) || !event?.price || typeof event.price !== 'object'
      || !Object.keys(event.price).length) return [];
    return [{ ...event, price: { ...event.price } }];
  });
}

/** Recover missing prices from retained source booking links, independently of the detail cursor. */
export async function recoverExistingBookingPrices(existingEvents, records, {
  deadline = Infinity,
  fetchFn = fetchEventBookingPrice,
  venueMatcher,
} = {}) {
  const datesById = new Map(records.map(({ objectID, perLocaleHits }) => {
    const primary = LOCALES.map(locale => perLocaleHits[locale]).find(Boolean);
    return [eventStableId(SOURCE.key, objectID), extractDateInfo(primary)?.startDate];
  }));
  const updates = [];
  for (const event of existingEvents) {
    if (hasParsedPrice(event.price) || datesById.get(event.id) !== event.startDate
      || !event.startDate || !supportedEventBookingUrl(event.price?.url)) continue;
    if (Date.now() >= deadline) break;
    try {
      const price = typeof venueMatcher === 'function'
        ? await fetchFn(event, event.price.url, { venueMatcher })
        : await fetchFn(event, event.price.url);
      // A third-party ticketing page is not a MySwitzerland field: recorded, not reliable.
      if (hasParsedPrice(price)) {
        updates.push({ ...event, price: { ...event.price, ...withEventPriceSource(price, SOURCE.key, 'booking-page') } });
      }
    } catch { /* Optional enrichment must not abort the primary crawl. */ }
  }
  return updates;
}

function normalizeVenueToken(value) {
  return typeof value === 'string'
    ? value.split(/\s+[-–—]\s+/)[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

/** Match a town-only venue to a specific venue only when the event locality proves the town. */
function sameBackfillVenue(freshEvent, backfillEvent) {
  const freshVenue = normalizeVenueToken(freshEvent?.venue);
  const backfillVenue = normalizeVenueToken(backfillEvent?.venue);
  const broadVenue = [freshVenue, backfillVenue].find(value => value && !value.includes(' '));
  const specificVenue = broadVenue
    && [freshVenue, backfillVenue].find(value => value !== broadVenue && value.includes(' '));
  const broadVenueMatchesSpecific = Boolean(specificVenue?.split(' ').includes(broadVenue));
  if (!freshVenue || !backfillVenue
    || (!sameVenue(freshEvent?.venue, backfillEvent?.venue) && !broadVenueMatchesSpecific)) return false;
  const freshLocalities = [freshEvent?.comune, freshEvent?.address?.locality]
    .map(normalizeVenueToken).filter(Boolean);
  const backfillLocalities = [backfillEvent?.comune, backfillEvent?.address?.locality]
    .map(normalizeVenueToken).filter(Boolean);
  const compatibleLocality = freshLocalities.some(freshLocality =>
    backfillLocalities.some(backfillLocality => sameVenue(freshLocality, backfillLocality)));
  const localityProof = [...freshLocalities, ...backfillLocalities]
    .some(locality => broadVenue && sameVenue(locality, broadVenue));
  if (freshLocalities.length && backfillLocalities.length && !compatibleLocality) return false;
  if (freshVenue === backfillVenue) return true;
  if (!broadVenue) return compatibleLocality;
  return localityProof;
}

/** Keep verified price metadata when a fresh detail record drops optional fields. */
export function applyKnownPriceBackfills(freshEvents, ...backfillGroups) {
  const backfills = new Map(backfillGroups.flat().filter(event => event?.id).map(event => [event.id, event]));
  return freshEvents.map(event => {
    const backfill = backfills.get(event?.id);
    if (!backfill || hasParsedPrice(event?.price) || !backfill?.price || typeof backfill.price !== 'object'
      || !Object.keys(backfill.price).length
      || !event?.startDate || !backfill.startDate || event.startDate !== backfill.startDate
      || !sameBackfillVenue(event, backfill)) return event;
    const freshMetadata = Object.fromEntries(
      // Provenance belongs to the value it describes: never pair the backfill
      // amount with the fresh record's priceSource/priceField.
      Object.entries(event.price || {}).filter(([key, value]) => value != null && !Object.hasOwn(backfill.price, key)
        && key !== 'priceSource' && key !== 'priceField'),
    );
    return { ...event, price: { ...freshMetadata, ...backfill.price } };
  });
}

/** Include recovered records that the bounded detail traversal did not visit. */
export function mergePriceBackfillRecords(freshEvents, ...backfillGroups) {
  const backfills = new Map(backfillGroups.flat().filter(event => event?.id).map(event => [event.id, event]));
  const mergedFresh = applyKnownPriceBackfills(freshEvents, ...backfillGroups);
  const freshIds = new Set(mergedFresh.map(event => event?.id).filter(Boolean));
  return [...mergedFresh, ...[...backfills.values()].filter(event => !freshIds.has(event.id))];
}

/**
 * {street, postalCode, locality, region} from JSON-LD `location.address`
 * (PostalAddress), or undefined. `locality`/`region` (issue #3739) surface
 * `addressLocality`/`addressRegion` so the caller can pass the region as a
 * high-confidence canton hint into `resolveComuneNationwide` instead of
 * relying solely on venue/title text-matching.
 */
export function extractAddress(ld) {
  const addr = ld?.location?.address;
  if (!addr || typeof addr !== 'object') return undefined;
  const street = typeof addr.streetAddress === 'string' && addr.streetAddress.trim() ? addr.streetAddress.trim() : undefined;
  const postalCode = typeof addr.postalCode === 'string' && addr.postalCode.trim() ? addr.postalCode.trim() : undefined;
  const locality = typeof addr.addressLocality === 'string' && addr.addressLocality.trim() ? addr.addressLocality.trim() : undefined;
  const region = typeof addr.addressRegion === 'string' && addr.addressRegion.trim() ? addr.addressRegion.trim() : undefined;
  if (!street && !postalCode && !locality && !region) return undefined;
  return { street, postalCode, locality, region };
}

/** Address fallback for detail pages that publish "Località" outside JSON-LD. */
export function extractDetailAddress(html) {
  const raw = extractDetailTableValue(html, ['Località', 'Location', 'Ort', 'Lieu']);
  if (!raw) return undefined;
  const parts = cleanText(raw)
    .split(/\s*[;|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const postalIndex = parts.findIndex((part) => /^(?:CH[- ]?)?\d{4}\b/i.test(part));
  if (postalIndex < 0) return undefined;
  const postalMatch = /^(?:CH[- ]?)?(\d{4})\s*,?\s*(.+)$/i.exec(parts[postalIndex]);
  if (!postalMatch) return undefined;
  const address = { postalCode: postalMatch[1], locality: postalMatch[2].trim() };
  if (postalIndex > 0) address.street = parts[postalIndex - 1];
  return address;
}

/** Returns true if `name` matches any name in a schema.org performer/organizer value (string | object | array). */
function matchesPersonField(name, field) {
  if (!field) return false;
  const lower = name.toLowerCase();
  const entries = Array.isArray(field) ? field : [field];
  for (const entry of entries) {
    const n = typeof entry === 'string' ? entry : (typeof entry?.name === 'string' ? entry.name : null);
    if (n && n.trim().toLowerCase() === lower) return true;
  }
  return false;
}

function extractVenue(ld, fallbackPlace) {
  const name = ld?.location?.name;
  if (typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    // Reject location.name that matches a performer or organizer name — implausible as a venue
    if (!matchesPersonField(trimmed, ld?.performer) && !matchesPersonField(trimmed, ld?.organizer)) {
      return trimmed;
    }
    // Implausible: fall back to addressLocality as a useful venue label
    const locality = ld?.location?.address?.addressLocality;
    if (typeof locality === 'string' && locality.trim()) return locality.trim();
  }
  return fallbackPlace || undefined;
}

const LD_JSON_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function eventJsonLdCandidates(value) {
  if (Array.isArray(value)) return value.flatMap(eventJsonLdCandidates);
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value['@graph'])) return value['@graph'].flatMap(eventJsonLdCandidates);
  return [value];
}

function isEventJsonLdType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) => typeof type === 'string' && (type === 'Event' || type.endsWith('Event')));
}

/** Pick the schema.org Event(-subtype) JSON-LD node off a detail page (skips BreadcrumbList etc). */
export function extractEventJsonLd(html) {
  if (typeof html !== 'string' || !html) return null;
  LD_JSON_RE.lastIndex = 0;
  let match;
  while ((match = LD_JSON_RE.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim().replace(/^<!--\s*|\s*-->$/g, ''));
      const event = eventJsonLdCandidates(parsed).find((candidate) => isEventJsonLdType(candidate?.['@type']) && candidate.startDate);
      if (event) return event;
    } catch {
      // malformed block — keep scanning the rest of the page
    }
  }
  return null;
}

/**
 * Fill only missing optional metadata from a later locale detail page.
 * Main event fields remain owned by the first usable locale, while named
 * organizer/performer entities and event-specific images can be recovered
 * from another locale variant of the same source event.
 */
export function mergeDetailEventMetadata(primaryLd, candidateLd, primaryUrl = SITE_ORIGIN, candidateUrl = SITE_ORIGIN) {
  if (!primaryLd) return candidateLd || null;
  if (!candidateLd) return primaryLd;
  const merged = { ...primaryLd };

  if (!firstEventImageUrl(merged.image, primaryUrl)) {
    const image = firstEventImageUrl(candidateLd.image, candidateUrl);
    if (image) merged.image = image;
  }
  for (const field of ['organizer', 'performer']) {
    const primaryPeople = normalizeEventPeople(merged[field], primaryUrl);
    const candidatePeople = normalizeEventPeople(candidateLd[field], candidateUrl);
    const candidateAddsOrganizerUrl = field === 'organizer'
      && candidatePeople
      && hasCompleteEventPeopleUrls(candidatePeople)
      && !hasCompleteEventPeopleUrls(primaryPeople);
    if (!primaryPeople || candidateAddsOrganizerUrl) {
      if (candidatePeople) {
        merged[field] = field === 'organizer' && primaryPeople
          ? mergeEventPeopleUrls(primaryPeople, candidatePeople)
          : candidatePeople;
      }
    }
  }
  const mergedOffers = mergeEventOfferMetadata(merged.offers, candidateLd.offers, primaryUrl, candidateUrl);
  if (mergedOffers !== undefined) merged.offers = mergedOffers;
  return merged;
}

/**
 * Pure mapping: one merged event (grouped Algolia hits across locales, plus
 * optional detail-page JSON-LD enrichment) → a SiteEvent-shaped record. Never
 * touches the network — `enrichment` is pre-fetched by the caller. Returns
 * `null` when the record has no usable title/date (dropped, not emitted).
 * `comune`/`canton` are left blank (`''`/undefined) and `imageUrl` absent —
 * those are filled in by `main()` (comune resolution + image mirroring are
 * async/impure and already covered by their own unit tests in
 * events-nationwide-sources.test.ts). Detail metadata can come from any
 * locale hit when the primary locale omits its image.
 */
export function mapEventRecord(objectID, perLocaleHits, enrichment = {}) {
  const {
    detailLd,
    detailUrl,
    detailHtml,
    detailAddress,
    detailContactName,
    detailImageSourceUrl,
    detailPrice,
    detailPeople,
  } = enrichment;
  const primaryLocale = LOCALES.find((l) => perLocaleHits[l]);
  const primary = primaryLocale ? perLocaleHits[primaryLocale] : undefined;
  if (!primary) return null;

  const dateInfo = extractDateInfo(primary);
  if (!dateInfo) return null;

  const titleByLocale = {};
  const descriptionByLocale = {};
  for (const locale of LOCALES) {
    const hit = perLocaleHits[locale];
    if (!hit) continue;
    if (typeof hit.title === 'string' && hit.title.trim()) titleByLocale[locale] = hit.title.trim();
    const desc = cleanText(hit.leadText) || cleanText(hit.content);
    if (desc) descriptionByLocale[locale] = desc;
  }
  const title = titleByLocale.it || titleByLocale.en || titleByLocale.de || titleByLocale.fr;
  if (!title) return null;
  const description = descriptionByLocale.it || descriptionByLocale.en || descriptionByLocale.de || descriptionByLocale.fr;

  const rawUrl = detailUrl
    || `${SITE_ORIGIN}/${LOCALE_URL_PREFIX[primaryLocale]}${String(primary.url || '').startsWith('/') ? primary.url : `/${primary.url || ''}`}`;
  const indexedPeople = extractEventPeopleFromText(
    LOCALES.flatMap((locale) => [perLocaleHits[locale]?.content, perLocaleHits[locale]?.leadText]).filter(Boolean).join('. '),
  );
  const indexedTitlePeople = LOCALES
    .map((locale) => extractEventPeopleFromTitle(perLocaleHits[locale]?.title).performer)
    .find(Boolean);
  const detailPeopleFromHtml = extractEventPeopleFromText(detailHtml);
  const sourcePeople = {
    organizer: detailPeople?.organizer || detailPeopleFromHtml.organizer || indexedPeople.organizer,
    performer: detailPeople?.performer || detailPeopleFromHtml.performer || indexedPeople.performer || indexedTitlePeople,
  };
  const organizer = normalizeEventPeople(detailLd?.organizer, detailUrl || SITE_ORIGIN, detailUrl)
    || normalizeEventPeople(sourcePeople.organizer, SITE_ORIGIN, detailUrl)
    || (detailContactName
      ? normalizeEventPeople({ '@type': 'Organization', name: detailContactName }, detailUrl || SITE_ORIGIN, detailUrl)
      : undefined);
  const performer = normalizeEventPeople(detailLd?.performer, detailUrl || SITE_ORIGIN)
    || normalizeEventPeople(sourcePeople.performer, SITE_ORIGIN);
  const ldAddress = extractAddress(detailLd);
  const htmlAddress = extractDetailAddress(detailHtml);
  const addressSource = ldAddress || htmlAddress || detailAddress;
  const address = addressSource
    ? {
        street: ldAddress?.street || htmlAddress?.street || detailAddress?.street,
        postalCode: ldAddress?.postalCode || htmlAddress?.postalCode || detailAddress?.postalCode,
        locality: ldAddress?.locality || htmlAddress?.locality || detailAddress?.locality,
        region: ldAddress?.region || htmlAddress?.region || detailAddress?.region,
      }
    : undefined;
  const imageSourceUrl =
    LOCALES.map((locale) => firstEventImageUrl(perLocaleHits[locale]?.image, SITE_ORIGIN)).find(Boolean)
    || firstEventImageUrl(detailLd?.image, detailUrl || SITE_ORIGIN)
    || detailImageSourceUrl
    || firstEventImageUrlFromHtml(detailHtml, detailUrl || SITE_ORIGIN);
  // A structured JSON-LD price wins over any tariff text, whichever locale
  // variant published it; text is kept only when no structured value exists.
  const priceCandidates = [
    extractPrice(detailLd, detailHtml, detailUrl),
    detailPrice,
    ...LOCALES.map((locale) => extractIndexedEventPrice(perLocaleHits[locale]?.content)),
  ];
  const price = priceCandidates.find(hasConfidentPrice) || priceCandidates.find(hasParsedPrice);
  const offerMetadata = extractEventOfferMetadata(detailLd?.offers, detailUrl || SITE_ORIGIN);

  return {
    event: fillEventPeopleDefaults({
      id: eventStableId(SOURCE.key, objectID),
      title,
      titleByLocale: Object.keys(titleByLocale).length ? titleByLocale : undefined,
      description: description || undefined,
      descriptionByLocale: Object.keys(descriptionByLocale).length ? descriptionByLocale : undefined,
      startDate: dateInfo.startDate,
      endDate: dateInfo.endDate,
      startTime: dateInfo.startTime,
      category: humanizeCategory(detailLd?.['@type']) || 'Event',
      venue: extractVenue(detailLd, primary.place),
      comune: undefined,
      canton: '',
      url: rawUrl,
      sourceKey: SOURCE.key,
      sourceName: SOURCE.label,
      price: price || offerMetadata ? { ...offerMetadata, ...price } : undefined,
      address,
      geo: extractGeo(primary),
      recurring: dateInfo.recurring,
      ...(organizer ? { organizer } : {}),
      ...(performer ? { performer } : {}),
    }, SOURCE),
    imageSourceUrl,
    place: primary.place || undefined,
  };
}

/** Fetch the first usable detail page and fill optional metadata from later locales when needed. */
async function fetchDetailEnrichment(perLocaleHits) {
  let enrichment = null;
  const sourcePeople = extractEventPeopleFromText(
    LOCALES.flatMap((locale) => [perLocaleHits[locale]?.content, perLocaleHits[locale]?.leadText]).filter(Boolean).join('. '),
  );
  const sourceTitlePeople = LOCALES
    .map((locale) => extractEventPeopleFromTitle(perLocaleHits[locale]?.title).performer)
    .find(Boolean);
  if (!sourcePeople.performer && sourceTitlePeople) sourcePeople.performer = sourceTitlePeople;
  for (const locale of LOCALES) {
    const hit = perLocaleHits[locale];
    if (!hit?.url) continue;
    const path_ = String(hit.url).startsWith('/') ? hit.url : `/${hit.url}`;
    const url = `${SITE_ORIGIN}/${LOCALE_URL_PREFIX[locale]}${path_}`;
    const html = await fetchHtml(url);
    if (!html) continue;
    const ld = extractEventJsonLd(html);
    const candidateAddress = extractAddress(ld) || extractDetailAddress(html);
    const candidatePrice = extractPrice(ld, html, url);
    const candidateContactName = extractDetailContactName(html);
    const candidateImageSourceUrl = firstEventImageUrlFromHtml(html, url);
    const candidatePeople = extractEventPeopleFromText(html);
    const hasHtmlMetadata = Boolean(
      candidateAddress
      || candidatePrice
      || candidateContactName
      || candidateImageSourceUrl
      || candidatePeople.organizer
      || candidatePeople.performer
    );
    if (!ld && !hasHtmlMetadata) continue;
    if (!enrichment) {
      enrichment = {
        detailLd: ld,
        detailUrl: url,
        detailHtml: html,
        detailAddress: candidateAddress,
        detailContactName: candidateContactName,
        detailImageSourceUrl: candidateImageSourceUrl,
        detailPrice: candidatePrice,
        detailPeople: candidatePeople,
      };
    } else if (ld && enrichment.detailLd) {
      enrichment.detailLd = mergeDetailEventMetadata(enrichment.detailLd, ld, enrichment.detailUrl, url);
    } else if (ld) {
      enrichment.detailLd = ld;
    }

    if (!enrichment.detailAddress && candidateAddress) enrichment.detailAddress = candidateAddress;
    if ((!enrichment.detailPrice || (enrichment.detailPrice.amount === null && candidatePrice?.amount !== null)
      || (!hasConfidentPrice(enrichment.detailPrice) && hasConfidentPrice(candidatePrice))) && candidatePrice) {
      enrichment.detailPrice = candidatePrice;
    }
    if (!enrichment.detailContactName && candidateContactName) enrichment.detailContactName = candidateContactName;
    if (!enrichment.detailImageSourceUrl && candidateImageSourceUrl) enrichment.detailImageSourceUrl = candidateImageSourceUrl;
    if (!enrichment.detailPeople?.organizer && candidatePeople.organizer) {
      enrichment.detailPeople = { ...enrichment.detailPeople, organizer: candidatePeople.organizer };
    }
    if (!enrichment.detailPeople?.performer && candidatePeople.performer) {
      enrichment.detailPeople = { ...enrichment.detailPeople, performer: candidatePeople.performer };
    }

    if (detailEnrichmentReady(enrichment, perLocaleHits, sourcePeople)) break;
  }
  return enrichment;
}

/**
 * Stop locale detail-page fetching only after every supported optional field
 * is resolved. Source attribution and an Algolia image alone are not enough:
 * address and price can live on a different localized detail page.
 */
export function detailEnrichmentReady(enrichment, perLocaleHits = {}, sourcePeople = {}) {
  const imageReady = Boolean(
    LOCALES.some((candidateLocale) => firstEventImageUrl(perLocaleHits[candidateLocale]?.image, SITE_ORIGIN))
    || firstEventImageUrl(enrichment?.detailLd?.image, enrichment?.detailUrl || SITE_ORIGIN)
    || enrichment?.detailImageSourceUrl,
  );
  const organizerEvidence = normalizeEventPeople(enrichment?.detailLd?.organizer, enrichment?.detailUrl || SITE_ORIGIN)
    || sourcePeople.organizer
    || normalizeEventPeople(enrichment?.detailPeople?.organizer, enrichment?.detailUrl || SITE_ORIGIN)
    || enrichment?.detailContactName;
  const organizerReady = Boolean(
    hasCompleteEventPeopleUrls(organizerEvidence)
    || (enrichment?.detailUrl && organizerEvidence)
  );
  const performerReady = Boolean(
    normalizeEventPeople(enrichment?.detailLd?.performer, enrichment?.detailUrl || SITE_ORIGIN)
    || sourcePeople.performer
    || normalizeEventPeople(enrichment?.detailPeople?.performer, enrichment?.detailUrl || SITE_ORIGIN),
  );
  const addressReady = Boolean(enrichment?.detailAddress);
  const priceReady = Boolean(enrichment?.detailPrice);
  return imageReady && organizerReady && performerReady && addressReady && priceReady;
}

export function parseMySwitzerlandArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  let limit;
  const eqArg = argv.find((a) => a.startsWith('--limit='));
  if (eqArg) {
    limit = Number.parseInt(eqArg.slice('--limit='.length), 10);
  } else {
    const idx = argv.indexOf('--limit');
    if (idx >= 0) limit = Number.parseInt(argv[idx + 1] || '', 10);
  }
  if (!Number.isFinite(limit) || limit <= 0) limit = undefined;
  const idsFlags = argv.filter(arg => arg === '--ids' || arg.startsWith('--ids='));
  if (idsFlags.length > 1) throw new Error('Specify --ids only once');
  let ids;
  if (idsFlags.length) {
    const flag = idsFlags[0];
    const raw = flag === '--ids' ? argv[argv.indexOf(flag) + 1] : flag.slice('--ids='.length);
    const tokens = typeof raw === 'string' ? raw.split(',').map(id => id.trim().replace(/^myswitzerland:/i, '').toLowerCase()) : [];
    if (!tokens.length || tokens.some(id => !/^[a-f0-9]{32}$/.test(id))) {
      throw new Error('--ids requires comma-separated MySwitzerland object IDs (32 hexadecimal characters)');
    }
    ids = [...new Set(tokens)].sort();
  }
  return { dryRun, limit, ids };
}

/** Keep catalog order for normal runs; targeted runs have stable ID order. */
export function selectMySwitzerlandRecords(records, ids) {
  if (!ids) return { records, selectionKey: null };
  const requested = new Set(ids);
  const selected = records.filter(record => requested.has(record.objectID.toLowerCase()))
    .sort((left, right) => left.objectID.toLowerCase().localeCompare(right.objectID.toLowerCase()));
  // Bind the cursor to both requested and currently available IDs. Catalog
  // removals or reappearances must not shift a persisted position silently.
  const selectionKey = createHash('sha256')
    .update(JSON.stringify([ids, selected.map(record => record.objectID.toLowerCase())])).digest('hex');
  return { records: selected, selectionKey };
}

export function targetedMySwitzerlandResumeIndex(checkpoint, selectionKey) {
  return checkpoint?.selectionKey === selectionKey && Number.isInteger(checkpoint.nextIndex) && checkpoint.nextIndex >= 0
    ? checkpoint.nextIndex : 0;
}

async function main() {
  const { dryRun, limit, ids } = parseMySwitzerlandArgs(process.argv.slice(2));
  const crawledAt = new Date().toISOString();
  const deadline = Date.now() + RUN_BUDGET_MS;
  const slicePath = path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`);
  const existingSlice = existsSync(slicePath)
    ? JSON.parse(readFileSync(slicePath, 'utf8'))
    : { events: [] };
  if (!Array.isArray(existingSlice.events)) throw new Error('Invalid MySwitzerland source slice');

  const localeMaps = {};
  for (const locale of LOCALES) {
    const index = LOCALE_INDEX[locale];
    const map = limit && !ids ? await enumerateEventsForLocaleLimited(index, limit) : await enumerateEventsForLocale(index);
    localeMaps[locale] = map;
    console.log(`[myswitzerland] ${locale} (${index}): ${map.size} Event record(s)`);
  }

  let records = groupHitsByObjectId(localeMaps);
  console.log(`[myswitzerland] ${records.length} unique event(s) in catalog across ${LOCALES.length} locales`);
  const selection = selectMySwitzerlandRecords(records, ids);
  records = selection.records;
  if (ids) {
    console.log(`[myswitzerland] selected ${records.length}/${ids.length} requested event(s); other source records are retained`);
    if (!records.length) throw new Error('None of the requested MySwitzerland IDs is available in the catalog');
  }
  if (limit) records = records.slice(0, limit);
  const knownPriceBackfills = recoverExistingKnownPrices(existingSlice.events, records);
  console.log(`[myswitzerland] ${knownPriceBackfills.length} existing price metadata record(s) retained for backfill`);
  const indexedPriceBackfills = recoverExistingIndexedPrices(existingSlice.events, records);
  console.log(`[myswitzerland] ${indexedPriceBackfills.length} existing unknown price(s) recovered from the public index`);
  const indexedIds = new Set(indexedPriceBackfills.map(event => event.id));
  const bookingPriceBackfills = await recoverExistingBookingPrices(
    existingSlice.events.filter(event => !indexedIds.has(event.id)), records, {
      deadline,
      venueMatcher: (sourceVenue, event) => sameBackfillVenue(event, { ...event, venue: sourceVenue }),
    },
  );
  console.log(`[myswitzerland] ${bookingPriceBackfills.length} existing unknown price(s) recovered from official booking pages`);

  const targetedCheckpointPath = path.join(CHECKPOINT_DIR, 'myswitzerland-targeted.json');
  const resumeIndex = ids
    ? targetedMySwitzerlandResumeIndex(loadGenericCursor(targetedCheckpointPath, null), selection.selectionKey)
    : loadCursor(SOURCE.key);
  const startIndex = limit ? 0 : resumeIndex % Math.max(records.length, 1);
  if (!limit && startIndex > 0) {
    console.log(`[myswitzerland] resuming from checkpoint index ${startIndex}/${records.length}`);
  }

  const events = [];
  const detailFailureIds = [];
  let detailOk = 0;
  let detailFail = 0;
  let visited = 0;
  let cursor = startIndex;

  while (visited < records.length) {
    if (!limit && Date.now() >= deadline) {
      console.log(
        `[myswitzerland] time budget (${RUN_BUDGET_MS}ms) reached after ${visited}/${records.length} event(s) — stopping, will resume next run`,
      );
      break;
    }

    const rec = records[cursor];
    const enrichment = await fetchDetailEnrichment(rec.perLocaleHits);
    if (enrichment) detailOk += 1;
    else {
      detailFail += 1;
      detailFailureIds.push(eventStableId(SOURCE.key, rec.objectID));
    }

    const mapped = mapEventRecord(rec.objectID, rec.perLocaleHits, enrichment || {});
    if (mapped) {
      const { event, imageSourceUrl, place } = mapped;
      // #3739: myswitzerland's own JSON-LD ships a clean 2-letter canton code
      // as `location.address.addressRegion` (e.g. "SZ") — pass it as the
      // high-confidence cantonHint instead of relying solely on venue/title
      // text-matching against the current BFS comune list, which misses
      // fused post-2011 comuni (Niederurnen -> Glarus Nord) and non-comune
      // toponyms (Petersplatz, a square inside Basel).
      const { comune, canton } = resolveComuneNationwide(
        { venue: [event.venue, place].filter(Boolean).join(' '), title: event.title, region: undefined },
        event.address?.region,
      );
      event.comune = comune || undefined;
      event.canton = canton || '';
      event.imageUrl = (await mirrorEventImage(imageSourceUrl, event.id)) || undefined;
      const frontier = resolveItalianFrontierComuni(event.geo);
      if (frontier.length) event.italianFrontierComuni = frontier;
      events.push(event);
    }

    visited += 1;
    cursor = (cursor + 1) % records.length;
    if (visited < records.length) await sleep(DETAIL_DELAY_MS);
  }

  const resolved = events.filter((e) => e.comune).length;
  console.log(
    `[myswitzerland] visited ${visited}/${records.length} event(s) this run — ${events.length} mapped — ` +
      `detail-page enrichment ${detailOk} ok / ${detailFail} fallback (index-only fields) — comune resolved ${resolved}/${events.length}`,
  );

  // #7328: myswitzerland's own `addressRegion` plus venue/title text-matching
  // still leaves ~1200 future events with no comune AND no canton at all,
  // nearly every one of them carrying usable coordinates — resolve those from
  // `geo` before they fall into the unresolved-canton bucket page.
  const geocodeCache = loadGeocodeCache();
  const geoStats = await enrichEventsWithGeoComune(events, geocodeCache, {
    deadline: Date.now() + GEO_COMUNE_BUDGET_MS,
  });
  console.log(
    `[myswitzerland] geo fallback: ${geoStats.cantonFilled} canton / ${geoStats.comuneFilled} comune attributed ` +
      `from coordinates (${geoStats.lookups} reverse-geocode lookup(s) this run)`,
  );

  // #3741: the Algolia per-locale search index very often ships the SAME
  // title/description text across it/en/de/fr (the organizer never
  // translated it) instead of a missing locale — fill those gaps via the
  // free-translate.mjs cascade, same disk cache as crawl-tio-agenda.mjs.
  const translationCache = loadEventTitleTranslationCache();
  const translatedEvents = await enrichEventsWithLocaleFallbackTranslations(events, translationCache, {
    deadline: Date.now() + TRANSLATE_BUDGET_MS,
  });
  const titleFilled = translatedEvents.filter((e) => e.titleByLocale && LOCALES.every((l) => e.titleByLocale[l])).length;
  console.log(`[myswitzerland] locale-fallback translation: ${titleFilled}/${translatedEvents.length} event(s) now have title in all ${LOCALES.length} locales`);
  const freshEvents = mergePriceBackfillRecords(
    translatedEvents,
    knownPriceBackfills,
    indexedPriceBackfills,
    bookingPriceBackfills,
  );

  if (dryRun) {
    console.log('🏃 dry-run — slice/checkpoint not written');
    console.log(JSON.stringify([...indexedPriceBackfills, ...bookingPriceBackfills, ...freshEvents].slice(0, 3), null, 2));
    return;
  }

  saveEventTitleTranslationCache(translationCache);
  saveGeocodeCache(geocodeCache);

  if (events.length === 0) {
    // Never overwrite a good slice with an empty run. Distinguish three causes:
    //  - the time budget ran out during Algolia enumeration itself, before any
    //    record was even visited (visited===0) → transient, soft-exit 0. This
    //    is expected on a slow run and NOT a drift signal: we never got far
    //    enough to learn anything about mapEventRecord/JSON-LD health.
    //  - Algolia queries themselves failed (network/WAF) → transient, soft-exit 0.
    //  - records were actually visited this run and none mapped → likely
    //    index/key/facet drift; exit non-zero so crawl-events.yml opens a
    //    failure issue instead of letting the dataset go silently stale.
    console.log('[myswitzerland] 0 events mapped by detail traversal this run');
    if (visited === 0) {
      console.log('[myswitzerland] time budget exhausted before any record was visited — transient, soft-exit 0');
    } else if (algoliaFailures > 0) {
      console.log(`[myswitzerland] ${algoliaFailures} Algolia request(s) failed — transient, soft-exit 0`);
    } else {
      console.error(
        `[myswitzerland] ${visited} record(s) visited this run but 0 mapped — check ALGOLIA_APP_ID/ALGOLIA_SEARCH_KEY/LOCALE_INDEX for drift`,
      );
      process.exitCode = 1;
      return;
    }
    if (indexedPriceBackfills.length === 0 && bookingPriceBackfills.length === 0) return;
  }

  const total = mergeEventsIntoSlice({
    slicePath,
    sourceKey: SOURCE.key,
    sourceName: SOURCE.label,
    freshEvents: freshEvents,
    goneIds: [],
    crawledAt,
    detailFailureIds,
    detailAttemptCount: visited,
  });
  // Advance the catalog only after the detail-failure policy accepts and
  // writes this slice. A rejected batch must be retried from the same cursor.
  if (!limit && records.length > 0) {
    if (ids) saveGenericCursor(targetedCheckpointPath, { selectionKey: selection.selectionKey, nextIndex: cursor, updatedAt: crawledAt });
    else saveCursor(SOURCE.key, cursor, crawledAt);
  }
  console.log(`[myswitzerland] merged ${events.length} detail record(s) + ${indexedPriceBackfills.length} indexed / ${bookingPriceBackfills.length} booking price backfill(s) → ${total} total in ${path.relative(process.cwd(), slicePath)}`);
}

// Only crawl when invoked directly (`node scripts/crawl-myswitzerland-events.mjs`),
// so tests can import the pure mapping functions without triggering a live crawl.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[myswitzerland] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
