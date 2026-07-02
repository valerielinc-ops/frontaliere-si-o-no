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
 *     locale, but NOT price/structured address/category — those only exist as
 *     schema.org Event JSON-LD on each event's own detail page, so we fetch
 *     one detail page per unique event (across up to 4 locale URLs) to enrich.
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
 * No artificial cap: a real run walks the ENTIRE catalog (tens of thousands of
 * records across ~20 Algolia buckets x 4 locales, then one detail-page fetch
 * per unique event). That detail-page pass is the slow part — at the polite
 * per-request delay below, a full run is a long-lived, scheduled crawl (hours,
 * not minutes), by design (issue #3125: "no pilot batch, must be complete").
 *
 * Usage:
 *   node scripts/crawl-myswitzerland-events.mjs                # full catalog
 *   node scripts/crawl-myswitzerland-events.mjs --limit=5      # fast local test
 *   node scripts/crawl-myswitzerland-events.mjs --dry-run      # parse + report, no write
 *
 * Exit code is always 0 unless an unexpected crash occurs, EXCEPT when Algolia
 * queries succeed but yield zero events (index/key/facet drift) — that exits 1
 * so crawl-events.yml can open a failure issue instead of the dataset going
 * silently stale (same soft/hard-fail distinction as crawl-tio-agenda.mjs).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  eventStableId,
  resolveComuneNationwide,
  resolveItalianFrontierComuni,
  mirrorEventImage,
} from './lib/events-utils.mjs';

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
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
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

/** Price from JSON-LD `offers` (object or array) or `isAccessibleForFree`. Undefined when unknown. */
export function extractPrice(ld) {
  const offersRaw = ld?.offers;
  const offers = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  const priced = offers
    .map((o) => (o && o.price !== undefined && o.price !== null ? Number(o.price) : NaN))
    .filter((n) => Number.isFinite(n));
  if (priced.length) {
    const amount = Math.min(...priced);
    const currency = offers.find((o) => typeof o?.priceCurrency === 'string')?.priceCurrency || 'CHF';
    return { amount, currency, isFree: amount === 0 };
  }
  if (ld?.isAccessibleForFree === true) return { amount: 0, currency: 'CHF', isFree: true };
  return undefined;
}

/** {street, postalCode} from JSON-LD `location.address` (PostalAddress), or undefined. */
export function extractAddress(ld) {
  const addr = ld?.location?.address;
  if (!addr || typeof addr !== 'object') return undefined;
  const street = typeof addr.streetAddress === 'string' && addr.streetAddress.trim() ? addr.streetAddress.trim() : undefined;
  const postalCode = typeof addr.postalCode === 'string' && addr.postalCode.trim() ? addr.postalCode.trim() : undefined;
  if (!street && !postalCode) return undefined;
  return { street, postalCode };
}

function extractVenue(ld, fallbackPlace) {
  const name = ld?.location?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return fallbackPlace || undefined;
}

const LD_JSON_RE = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** Pick the schema.org Event(-subtype) JSON-LD block off a detail page (skips BreadcrumbList etc). */
export function extractEventJsonLd(html) {
  if (typeof html !== 'string' || !html) return null;
  LD_JSON_RE.lastIndex = 0;
  let match;
  while ((match = LD_JSON_RE.exec(html))) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj && typeof obj === 'object' && obj['@type'] && obj.startDate) return obj;
    } catch {
      // malformed block — keep scanning the rest of the page
    }
  }
  return null;
}

/**
 * Pure mapping: one merged event (grouped Algolia hits across locales, plus
 * optional detail-page JSON-LD enrichment) → a SiteEvent-shaped record. Never
 * touches the network — `enrichment` is pre-fetched by the caller. Returns
 * `null` when the record has no usable title/date (dropped, not emitted).
 * `comune`/`canton` are left blank (`''`/undefined) and `imageUrl` absent —
 * those are filled in by `main()` (comune resolution + image mirroring are
 * async/impure and already covered by their own unit tests in
 * events-nationwide-sources.test.ts).
 */
export function mapEventRecord(objectID, perLocaleHits, enrichment = {}) {
  const { detailLd, detailUrl } = enrichment;
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

  return {
    event: {
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
      price: extractPrice(detailLd),
      address: extractAddress(detailLd),
      geo: extractGeo(primary),
      recurring: dateInfo.recurring,
    },
    imageSourceUrl: primary.image || undefined,
    place: primary.place || undefined,
  };
}

/** One detail-page fetch per event, trying each locale URL until one parses. */
async function fetchDetailEnrichment(perLocaleHits) {
  for (const locale of LOCALES) {
    const hit = perLocaleHits[locale];
    if (!hit?.url) continue;
    const path_ = String(hit.url).startsWith('/') ? hit.url : `/${hit.url}`;
    const url = `${SITE_ORIGIN}/${LOCALE_URL_PREFIX[locale]}${path_}`;
    const html = await fetchHtml(url);
    if (!html) continue;
    const ld = extractEventJsonLd(html);
    if (ld) return { detailLd: ld, detailUrl: url };
  }
  return null;
}

function parseArgs(argv) {
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
  return { dryRun, limit };
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const crawledAt = new Date().toISOString();

  const localeMaps = {};
  for (const locale of LOCALES) {
    const index = LOCALE_INDEX[locale];
    const map = limit ? await enumerateEventsForLocaleLimited(index, limit) : await enumerateEventsForLocale(index);
    localeMaps[locale] = map;
    console.log(`[myswitzerland] ${locale} (${index}): ${map.size} Event record(s)`);
  }

  let records = groupHitsByObjectId(localeMaps);
  console.log(`[myswitzerland] ${records.length} unique event(s) merged across ${LOCALES.length} locales`);
  if (limit) records = records.slice(0, limit);

  const events = [];
  let detailOk = 0;
  let detailFail = 0;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const enrichment = await fetchDetailEnrichment(rec.perLocaleHits);
    if (enrichment) detailOk += 1;
    else detailFail += 1;

    const mapped = mapEventRecord(rec.objectID, rec.perLocaleHits, enrichment || {});
    if (mapped) {
      const { event, imageSourceUrl, place } = mapped;
      const { comune, canton } = resolveComuneNationwide(
        { venue: [event.venue, place].filter(Boolean).join(' '), title: event.title, region: undefined },
        undefined,
      );
      event.comune = comune || undefined;
      event.canton = canton || '';
      event.imageUrl = (await mirrorEventImage(imageSourceUrl, event.id)) || undefined;
      const frontier = resolveItalianFrontierComuni(event.geo);
      if (frontier.length) event.italianFrontierComuni = frontier;
      events.push(event);
    }

    if (i < records.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  const resolved = events.filter((e) => e.comune).length;
  console.log(
    `[myswitzerland] ${events.length} events written — detail-page enrichment ${detailOk} ok / ${detailFail} fallback ` +
      `(index-only fields) — comune resolved ${resolved}/${events.length}`,
  );

  if (dryRun) {
    console.log('🏃 dry-run — slice not written');
    console.log(JSON.stringify(events.slice(0, 3), null, 2));
    return;
  }

  if (events.length === 0) {
    // Never overwrite a good slice with an empty one. Distinguish two causes:
    //  - Algolia queries themselves failed (network/WAF) → transient, soft-exit 0.
    //  - Algolia queries succeeded but nothing mapped to a valid event → likely
    //    index/key/facet drift; exit non-zero so crawl-events.yml opens a
    //    failure issue instead of letting the dataset go silently stale.
    console.log('[myswitzerland] 0 events parsed — leaving existing slice untouched');
    if (algoliaFailures > 0) {
      console.log(`[myswitzerland] ${algoliaFailures} Algolia request(s) failed — transient, soft-exit 0`);
    } else {
      console.error('[myswitzerland] Algolia queries succeeded but yielded 0 events — check ALGOLIA_APP_ID/ALGOLIA_SEARCH_KEY/LOCALE_INDEX for drift');
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(EVENTS_SLICE_DIR, { recursive: true });
  const slicePath = path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`);
  const slice = {
    schemaVersion: 1,
    sourceKey: SOURCE.key,
    sourceName: SOURCE.label,
    assembledAt: crawledAt,
    events,
  };
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
  console.log(`[myswitzerland] wrote ${events.length} events → ${path.relative(process.cwd(), slicePath)}`);
}

// Only crawl when invoked directly (`node scripts/crawl-myswitzerland-events.mjs`),
// so tests can import the pure mapping functions without triggering a live crawl.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[myswitzerland] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
