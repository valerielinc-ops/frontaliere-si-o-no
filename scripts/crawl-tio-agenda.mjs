#!/usr/bin/env node
/**
 * Crawler — Tio.ch Agenda (events for the whole canton of Ticino).
 *
 * One quota-free crawler (plain fetch + jsdom, no API key) covers every Ticino
 * comune: tio.ch publishes a day-indexed agenda at `/agenda/day/<YYYYMMDD>`
 * with one card per event (date, time, category, region, title, venue, flyer
 * image and a detail link). We walk the next N days, parse the cards, resolve
 * each event to a canonical comune (see scripts/lib/events-utils.mjs) and write
 * a per-source slice that `assemble-events-dataset.mjs` merges into the global
 * dataset consumed by `eventsSeoPagesPlugin`.
 *
 * Flyer images (issue #3036 item 3): the raw flyer URL each card links to
 * (tio.ch embeds thumbnails hosted on biglietteria.ch, a third-party ticketing
 * site with no stated reuse terms) is NEVER hotlinked into production — see
 * `mirrorEventImages` below, which downloads each flyer once via
 * events-utils.mjs `mirrorEventImage` and replaces the URL with our own
 * mirrored `/images/events/...` copy (or drops it entirely on any failure),
 * the same convention `crawl-guidle-events.mjs` / `crawl-myswitzerland-events.mjs`
 * already use.
 *
 * Price ("offers" JSON-LD gap): the day-page card never carries a price, only
 * the per-event detail page does (a "Prezzo:" label, empty/hidden when tio.ch
 * has no price on file). `enrichEventsWithPrice` below fetches each event's
 * own detail page once and parses it with the same `parsePriceText` guidle
 * uses, so `eventLd()` (build-plugins/eventsSeoPagesPlugin.ts) can emit a
 * real `offers` block instead of omitting it — never fabricated: an event
 * with no price signal at all still gets no `offers`, by design.
 *
 * Usage:
 *   node scripts/crawl-tio-agenda.mjs                 # next 21 days
 *   node scripts/crawl-tio-agenda.mjs --days 30       # custom horizon
 *   node scripts/crawl-tio-agenda.mjs --dry-run       # parse + report, no write
 *
 * Exit code is always 0 unless an unexpected crash occurs (CI-soft).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  EVENTS_CANTON,
  eventStableId,
  isoFromCompactDate,
  isoDay,
  resolveComune,
  loadCantonComuni,
  mirrorEventImage,
  parsePriceText,
  normalizeText,
  geocodeVenue,
  loadGeocodeCache,
  saveGeocodeCache,
  loadEventTitleTranslationCache,
  saveEventTitleTranslationCache,
} from './lib/events-utils.mjs';
import { freeTranslateWithRetry } from './lib/free-translate.mjs';

const SOURCE = EVENT_SOURCES['tio-agenda'];
const DAY_URL = (compact) => `https://www.tio.ch/agenda/day/${compact}`;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const FETCH_TIMEOUT_MS = 20000;
const POLITE_DELAY_MS = 600;
// Politeness delay between per-event flyer-image mirror fetches (a distinct
// host, biglietteria.ch, from the tio.ch day pages above) — short since
// mirrorEventImage is idempotent (skips the network call for any id already
// in data/events-image-manifest.json — since #6163 the mirrored bytes are on
// the CDN, not in git, so the committed manifest is what carries the
// "already mirrored" fact across runs), so a steady-state re-crawl only pays
// this for genuinely new events.
const IMAGE_MIRROR_DELAY_MS = 150;
// Politeness delay between per-event detail-page fetches (price extraction —
// same tio.ch host as the day pages, so same order of magnitude delay). Not
// idempotent/cached like the image mirror: price can change run to run, so
// every event is re-fetched every crawl. At ~136 events/run this adds ~80s,
// well inside the 35min crawl-events.yml budget.
const PRICE_FETCH_DELAY_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compactDay(date) {
  return isoDay(date).replace(/-/g, '');
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Category key from the `background_agenda_<cat>` color span class. */
function categoryFromCard(card) {
  const span = card.querySelector('.category-color');
  const cls = span?.className || '';
  const m = /background_agenda_([a-z0-9-]+)/i.exec(cls);
  return m ? m[1].toLowerCase() : '';
}

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse one day page into event objects. Real event cards carry an href of the
 * form `/agenda/day/<date>/<id>`; the date-picker cards (`/agenda/day/<date>`
 * only) are filtered out.
 */
export function parseDayHtml(html, compact) {
  const startDate = isoFromCompactDate(compact);
  const doc = new JSDOM(html).window.document;
  const comuni = loadCantonComuni(EVENTS_CANTON);
  const events = [];
  const seen = new Set();

  for (const card of doc.querySelectorAll('.agenda-event')) {
    const a = card.querySelector('a[href]');
    const href = a?.getAttribute('href') || '';
    const detail = /\/agenda\/day\/\d+\/(\d+)/.exec(href);
    if (!detail) continue; // date-picker card, not an event

    const rawId = detail[1];
    if (seen.has(rawId)) continue;
    seen.add(rawId);

    const title = text(card.querySelector('.card-title'));
    if (!title) continue;

    const smalls = [...card.querySelectorAll('.card-text small')].map(text);
    const time = (smalls.find((s) => /^\d{1,2}[.:]\d{2}$/.test(s)) || '').replace('.', ':');
    const region = smalls.length ? smalls[smalls.length - 1] : '';
    const category = categoryFromCard(card);
    const venue = text(card.querySelector('.card-text.description'));
    const img = card.querySelector('img.card-img-top, img');
    const imageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
    const { comune, method } = resolveComune({ venue, title, region }, comuni);

    events.push({
      id: eventStableId(SOURCE.key, rawId),
      title,
      startDate,
      startTime: time || undefined,
      category: category || undefined,
      region: region || undefined,
      venue: venue || undefined,
      comune: comune || undefined,
      comuneMatch: method || undefined,
      canton: SOURCE.canton,
      url: href.startsWith('http') ? href : `https://www.tio.ch${href}`,
      imageUrl: imageUrl || undefined,
      sourceKey: SOURCE.key,
      sourceName: SOURCE.label,
    });
  }
  return events;
}

// Thresholds for the low-confidence comune-attribution warning below.
const REGION_FALLBACK_WARN_RATIO = 0.5;
const REGION_FALLBACK_MIN_SAMPLE = 10;

/**
 * Warn when the 'region' resolveComune() path (lower confidence — the
 * venue/title text never named a specific comune, so the event is
 * attributed to the region's main comune instead) dominates a run's
 * resolved events (issue #3036 item 4). This doesn't break anything
 * visibly, but it silently concentrates per-comune SEO content on a few
 * main comuni, so a dominant share is worth surfacing — countable
 * run-over-run instead of buried in the plain summary log line above.
 * Skipped below `REGION_FALLBACK_MIN_SAMPLE` so a small/fixture run can't
 * false-positive on ratio alone.
 */
export function warnIfLowConfidenceComuneShare(byMethod, resolved) {
  if (resolved < REGION_FALLBACK_MIN_SAMPLE) return false;
  const regionShare = (byMethod.region || 0) / resolved;
  if (regionShare <= REGION_FALLBACK_WARN_RATIO) return false;
  console.warn(
    `[tio-agenda] low-confidence comune attribution: ${byMethod.region || 0}/${resolved} ` +
      `(${Math.round(regionShare * 100)}%) resolved via region fallback, not an exact venue/` +
      `title match — per-comune SEO pages may over-concentrate on each region's main comune; ` +
      `see resolveComune() jsdoc in scripts/lib/events-utils.mjs`,
  );
  return true;
}

/**
 * Mirror every event's flyer image to our own CDN storage before it ever
 * reaches the slice file / dataset — the no-hotlink policy (see
 * events-utils.mjs mirrorEventImage header) requires `imageUrl` to always be
 * either a site-relative mirrored path or absent, NEVER the raw
 * tio.ch/biglietteria.ch flyer URL `parseDayHtml` extracts from the DOM.
 * Mirrors the guidle/myswitzerland crawlers' convention (map → mirror →
 * store), just applied as a post-pass here since tio-agenda parses every
 * event straight off the already-fetched day pages — the card itself never
 * carries a price either, that's a separate per-event fetch, see
 * `enrichEventsWithPrice` below.
 *
 * Returns a NEW array (does not mutate `events`). `mirrorFn` is injectable so
 * tests can verify the replace-or-drop contract without a live network call.
 */
export async function mirrorEventImages(events, mirrorFn = mirrorEventImage) {
  const out = [];
  for (const ev of events) {
    const imageUrl = (await mirrorFn(ev.imageUrl, ev.id)) || undefined;
    out.push({ ...ev, imageUrl });
    // Only pace real network attempts (skipped for events with no source
    // image at all, and skipped entirely under an injected test mirrorFn).
    if (mirrorFn === mirrorEventImage && ev.imageUrl) await sleep(IMAGE_MIRROR_DELAY_MS);
  }
  return out;
}

/**
 * Parse an event detail page's "Prezzo:" label into `{amount, currency,
 * isFree}` via the shared `parsePriceText` (same parser guidle's price
 * accordion uses). tio.ch renders the label unconditionally but leaves it
 * empty when no price is on file — `parsePriceText('')` correctly returns
 * `undefined` for that case, so no price signal never becomes a fabricated
 * one. Returns `undefined` when the label itself is missing (page shape
 * changed, or fetch returned something unexpected).
 */
export function extractTioPrice(html) {
  const m = /<strong>\s*Prezzo:\s*<\/strong>\s*([^<]*)/i.exec(html || '');
  if (!m) return undefined;
  return parsePriceText(m[1]);
}

/**
 * Fetch each event's own detail page once and attach a `price` (the day-page
 * card this crawler otherwise parses never carries one — see file header).
 * Populating `price` here is what lets `eventLd()`
 * (build-plugins/eventsSeoPagesPlugin.ts) emit a real schema.org `offers`
 * block for tio-agenda events instead of always omitting it.
 *
 * Not idempotent/cached like `mirrorEventImages` — every event is re-fetched
 * every run since price can change. A fetch failure (network/timeout) just
 * leaves `price` unset, same soft-fail convention as `fetchHtml` callers
 * elsewhere in this file.
 *
 * Returns a NEW array (does not mutate `events`). `fetchFn` is injectable so
 * tests can verify parsing without a live network call.
 */
export async function enrichEventsWithPrice(events, fetchFn = fetchHtml) {
  const out = [];
  for (const ev of events) {
    const html = ev.url ? await fetchFn(ev.url) : null;
    const price = html ? extractTioPrice(html) : undefined;
    out.push(price ? { ...ev, price } : { ...ev });
    if (fetchFn === fetchHtml) await sleep(PRICE_FETCH_DELAY_MS);
  }
  return out;
}

// Nominatim usage policy caps free/anonymous search at ~1 request/second.
const GEOCODE_DELAY_MS = 1100;

/**
 * Attach `geo` (lat/lng) to every event that has neither — tio-agenda cards
 * carry no coordinates at all (unlike guidle/myswitzerland), so a detail page
 * previously had nothing to put on a map (see events-utils.mjs `geocodeVenue`
 * header). Resolves via free OpenStreetMap Nominatim, disk-cached by
 * normalized "venue, comune, Ticino, Switzerland" query so a venue already
 * geocoded on a previous run never re-hits the network — the crawler
 * rewrites its whole slice from scratch every run (see `main` below), so
 * without this cache every event would pay a fresh geocode every day.
 * Skips events with neither `venue` nor `comune` (nothing to search for) —
 * never fabricates a location.
 *
 * Returns a NEW array (does not mutate `events`). `geocodeFn`/`cache` are
 * injectable so tests can verify the enrichment without a live network call.
 */
export async function enrichEventsWithGeo(events, cache, geocodeFn = geocodeVenue) {
  const out = [];
  for (const ev of events) {
    if (ev.geo || (!ev.venue && !ev.comune)) {
      out.push({ ...ev });
      continue;
    }
    const query = [ev.venue, ev.comune, 'Ticino', 'Switzerland'].filter(Boolean).join(', ');
    const wasCached = Object.prototype.hasOwnProperty.call(cache, normalizeText(query));
    const geo = await geocodeFn(query, cache);
    out.push(geo ? { ...ev, geo } : { ...ev });
    if (geocodeFn === geocodeVenue && !wasCached) await sleep(GEOCODE_DELAY_MS);
  }
  return out;
}

const TRANSLATE_DELAY_MS = 200;
const TRANSLATE_LOCALES = ['en', 'de', 'fr'];

/**
 * Attach `titleByLocale` to every event — tio-agenda cards carry only a
 * single Italian `title` (unlike guidle/myswitzerland, which already ship
 * real per-locale titles), so en/de/fr readers previously saw untranslated
 * Italian text. Translates via the free-translate.mjs cascade, disk-cached by
 * normalized Italian title so a recurring event title already translated on
 * a previous run never re-hits the network — the crawler rewrites its whole
 * slice from scratch every run (see `main` below), so without this cache the
 * same recurring titles would be re-translated every single day.
 *
 * Returns a NEW array (does not mutate `events`). `translateFn`/`cache` are
 * injectable so tests can verify the enrichment without a live network call.
 */
export async function enrichEventsWithTranslations(events, cache, translateFn = freeTranslateWithRetry) {
  const out = [];
  for (const ev of events) {
    const key = normalizeText(ev.title);
    if (!key) {
      out.push({ ...ev });
      continue;
    }
    let entry = cache[key];
    if (!entry || Object.keys(entry).length < TRANSLATE_LOCALES.length) {
      entry = {};
      for (const locale of TRANSLATE_LOCALES) {
        const translated = await translateFn({
          text: ev.title,
          sourceLang: 'it',
          targetLang: locale,
          fieldType: 'title',
          maxRetries: 1,
        });
        if (translated) entry[locale] = translated;
        if (translateFn === freeTranslateWithRetry) await sleep(TRANSLATE_DELAY_MS);
      }
      if (Object.keys(entry).length === TRANSLATE_LOCALES.length) cache[key] = entry;
    }
    if (Object.keys(entry).length === 0) {
      out.push({ ...ev });
      continue;
    }
    out.push({ ...ev, titleByLocale: { it: ev.title, ...entry } });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Math.max(1, Number.parseInt(args[daysIdx + 1] || '21', 10)) : 21;

  const crawledAt = new Date().toISOString();
  const today = new Date(`${isoDay(new Date())}T00:00:00Z`);
  const byId = new Map();
  let pagesOk = 0;
  let pagesFail = 0;

  for (let i = 0; i < days; i += 1) {
    const date = new Date(today.getTime() + i * 86400000);
    const compact = compactDay(date);
    const html = await fetchHtml(DAY_URL(compact));
    if (!html) {
      pagesFail += 1;
      continue;
    }
    pagesOk += 1;
    for (const ev of parseDayHtml(html, compact)) {
      // Multi-day events recur on each day page; keep the earliest start and
      // extend endDate so we emit one record per event, not one per day.
      const existing = byId.get(ev.id);
      if (existing) {
        existing.endDate = ev.startDate;
      } else {
        byId.set(ev.id, { ...ev, crawledAt });
      }
    }
    if (i < days - 1) await sleep(POLITE_DELAY_MS);
  }

  const events = [...byId.values()];
  const resolved = events.filter((e) => e.comune).length;
  const byMethod = events.reduce((acc, e) => {
    const k = e.comuneMatch || 'none';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  console.log(
    `[tio-agenda] ${events.length} events over ${days} days ` +
      `(${pagesOk} pages ok, ${pagesFail} failed) — comune resolved ${resolved}/${events.length} ` +
      `(exact ${byMethod.exact || 0}, region ${byMethod.region || 0}, none ${byMethod.none || 0})`,
  );

  warnIfLowConfidenceComuneShare(byMethod, resolved);

  if (events.length === 0) {
    // Never overwrite a good slice with an empty one. Distinguish two causes:
    //  - all pages failed to load (network/WAF) → transient, soft-exit 0.
    //  - pages loaded (HTTP 200) but nothing parsed → likely tio.ch DOM drift
    //    (our selectors went stale); exit non-zero so crawl-events.yml opens a
    //    failure issue instead of letting the dataset go silently stale.
    console.log('[tio-agenda] 0 events parsed — leaving existing slice untouched');
    if (pagesOk > 0) {
      console.error(`[tio-agenda] DOM drift? ${pagesOk} page(s) returned HTTP 200 but yielded 0 events — check the .agenda-event selectors`);
      process.exitCode = 1;
    }
    return;
  }

  // Per-event detail fetch (offers/JSON-LD gap): attach `price` where tio.ch
  // has one on file, BEFORE mirroring images or writing the slice — see
  // `enrichEventsWithPrice` above.
  const pricedEvents = await enrichEventsWithPrice(events);
  const withPrice = pricedEvents.filter((e) => e.price).length;
  console.log(`[tio-agenda] price resolved ${withPrice}/${pricedEvents.length}`);

  // No-hotlink policy (events-utils.mjs mirrorEventImage): replace every raw
  // tio.ch/biglietteria.ch flyer URL with our own mirrored copy (or drop it)
  // BEFORE it reaches the dry-run preview or the written slice.
  const mirroredEvents = await mirrorEventImages(pricedEvents);

  // Geo + title-translation enrichment (tio-agenda cards carry neither, see
  // enrichEventsWithGeo/enrichEventsWithTranslations above) — disk-cached so
  // a from-scratch daily rebuild never re-pays the network for a venue/title
  // it already resolved on a previous run.
  const geocodeCache = loadGeocodeCache();
  const geoEvents = await enrichEventsWithGeo(mirroredEvents, geocodeCache);
  const withGeo = geoEvents.filter((e) => e.geo).length;
  console.log(`[tio-agenda] geo resolved ${withGeo}/${geoEvents.length}`);

  const translationCache = loadEventTitleTranslationCache();
  const translatedEvents = await enrichEventsWithTranslations(geoEvents, translationCache);
  const withTranslation = translatedEvents.filter((e) => e.titleByLocale).length;
  console.log(`[tio-agenda] title translated ${withTranslation}/${translatedEvents.length}`);

  if (dryRun) {
    console.log('🏃 dry-run — slice not written');
    console.log(JSON.stringify(translatedEvents.slice(0, 3), null, 2));
    return;
  }

  // Persist caches only on a real (non-dry-run) write, so a --dry-run/test
  // invocation never pollutes the tracked cache files with speculative data.
  saveGeocodeCache(geocodeCache);
  saveEventTitleTranslationCache(translationCache);

  mkdirSync(EVENTS_SLICE_DIR, { recursive: true });
  const slicePath = path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`);
  const slice = {
    schemaVersion: 1,
    sourceKey: SOURCE.key,
    sourceName: SOURCE.label,
    canton: SOURCE.canton,
    assembledAt: crawledAt,
    events: translatedEvents,
  };
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
  console.log(`[tio-agenda] wrote ${translatedEvents.length} events → ${path.relative(process.cwd(), slicePath)}`);
}

// Only crawl when invoked directly (`node scripts/crawl-tio-agenda.mjs`), so
// tests can import `parseDayHtml` without triggering a live fetch.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[tio-agenda] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
