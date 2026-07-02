#!/usr/bin/env node
/**
 * Crawler — Guidle (nationwide Switzerland events aggregator, issue #3125).
 *
 * guidle.com (https://www.guidle.com) is a white-label events/tourism platform
 * used by hundreds of Swiss municipalities and tourism offices, aggregated
 * under one public portal, natively published in up to 8 languages (we only
 * care about it/en/de/fr, the site's 4 "main" locales and the ones the rest of
 * the events pipeline localizes into — see EVENTS_BASE_PATH).
 *
 * Verified live 2026-07-02, in order of what was tried:
 *   - The listing pages (`/de/veranstaltungen/alle` etc) are a client-side Vue
 *     app (`portal-app.min.js`) that calls a `/api/rest/2.0/portals/*` REST
 *     API with `withCredentials:true` + a static `X-Wizard-App` header. Even
 *     with that header and a session cookie the `search-offers` endpoint kept
 *     returning `{"valid":false}` for every id tried (page id, root id,
 *     sitemap id, filters id) — the real request additionally needs a
 *     `sectionId` resolved from a `page/<id>` call plus store-internal state
 *     that isn't worth fully reverse-engineering when a much simpler, fully
 *     public path exists (see next point). Not used.
 *   - Serving a `Googlebot` user-agent to a listing page returns a fully
 *     prerendered version (dynamic rendering for SEO) — confirmed this is
 *     real, but deliberately NOT used: claiming to be Google's own crawler
 *     would be identity spoofing, not the "respectful, clearly-identified"
 *     crawling this feature requires (see events-utils.mjs mirrorEventImage
 *     header). Not used.
 *   - `https://www.guidle.com/sitemapindex.xml` → 6 gzipped shards
 *     (`sitemap1.xml.gz` … `sitemap6.xml.gz`, ~180k `<loc>` lines each) that
 *     ARE fully public and robots.txt-allowed (robots.txt only disallows
 *     ajax/print/utility paths). Together they list 119'800 unique individual
 *     event detail URLs (deduped by their trailing `_<code>` id, verified live
 *     — zero collisions across the full corpus) across it/en/de/fr/cs/es/nl/pt.
 *     This is the enumeration mechanism used here.
 *   - Every event detail page (e.g.
 *     `https://www.guidle.com/it/eventi/party/ascona/floating-notes…_AS26x6V`)
 *     is plain server-rendered HTML (no JS needed, no bot UA needed) and
 *     embeds schema.org `Event` JSON-LD (a single object, or an ARRAY of
 *     objects — one per occurrence — for recurring events), the primary data
 *     source here (title, description, startDate/endDate/time, venue,
 *     address, image). `<meta name="geo.position" content="lat;lng">` gives
 *     geo coordinates and `<meta name="geo.region" content="CH-ZG">` gives the
 *     canton directly (stripped of the `CH-` prefix) — a strong `cantonHint`
 *     for `resolveComuneNationwide`, which most sources don't have. Category
 *     and free-text price are NOT in the JSON-LD; they're DOM-scraped from
 *     `.accordion-wrap` blocks labelled "Kategorie"/"Preis" (and their
 *     it/en/fr translations — see CATEGORY_LABELS/PRICE_LABELS).
 *   - The in-page language `<select id="lang-selector">` proves the SAME path
 *     (everything after the 2-letter locale prefix, code included) resolves
 *     for every locale of the SAME event — e.g. both
 *     `/de/eventi/party/ascona/…_AS26x6V` and `/it/eventi/party/ascona/…_AS26x6V`
 *     are valid (the middle path segment is NOT re-translated by the
 *     selector). So for every event found in the sitemap we derive its
 *     it/en/de/fr URLs ourselves (swap the locale prefix, keep the rest) and
 *     fetch all 4, instead of only knowing whichever single locale the
 *     sitemap happened to list. This is what gives `titleByLocale`/
 *     `descriptionByLocale` real per-locale text (when an organizer actually
 *     filled in a translation — many haven't, and the untranslated locale
 *     just repeats the source-language text, which is honest, not a bug).
 *   - A large fraction of sitemap entries are stale (event already happened)
 *     and 404/410 on fetch — skipped per-locale (and the whole event is
 *     skipped if EVERY locale 404s/410s).
 *
 * No artificial cap: the full sitemap (119k+ events × up to 4 locale fetches
 * each) is walked across MANY scheduled runs, not one. A single run is
 * bounded by GUIDLE_CRAWL_BUDGET_MS (default 8 minutes, well inside
 * crawl-events.yml's shared 35-minute job timeout) — it re-derives the full
 * ordered event list from the sitemap every run (cheap: 6 shard fetches),
 * then walks a slice of it starting at a persisted cursor
 * (data/events/checkpoints/guidle.json, see scripts/lib/crawl-checkpoint.mjs)
 * and wraps back to the start once the whole catalog has been visited.
 * Each run MERGES what it found into the existing on-disk slice instead of
 * overwriting it wholesale, so a run that stops at its time budget never
 * loses prior runs' progress — coverage of the full catalog accrues over
 * many scheduled runs (issue #3125: "no pilot batch, must be complete" — no
 * permanent cap on total events ever crawled). Same design used for
 * crawl-myswitzerland-events.mjs.
 *
 * Respectful, non-evasive crawling: plain `fetch`, no headless browser, no
 * bot-identity spoofing, a clearly identifying User-Agent (matches the
 * tio-agenda / myswitzerland / mirrorEventImage convention), and a politeness
 * delay between every request to the guidle.com origin. Every event image is
 * mirrored once via `mirrorEventImage` — the output slice NEVER references a
 * guidle.com/imagekit.io image URL directly.
 *
 * Usage:
 *   node scripts/crawl-guidle-events.mjs                # one time-budgeted, checkpointed slice of the catalog
 *   node scripts/crawl-guidle-events.mjs --limit=5      # fast local test (bypasses the checkpoint)
 *   node scripts/crawl-guidle-events.mjs --dry-run      # parse + report, no write
 *
 * Exit code is always 0 unless an unexpected crash occurs, EXCEPT when this
 * run's detail-page fetches succeeded (real HTML came back) but yielded zero
 * mapped events (structural drift) — that exits 1 so crawl-events.yml can
 * open a failure issue instead of the dataset going silently stale (same
 * soft/hard-fail distinction as the other two crawlers).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  eventStableId,
  resolveComuneNationwide,
  mirrorEventImage,
} from './lib/events-utils.mjs';
import { loadCursor, saveCursor, mergeEventsIntoSlice } from './lib/crawl-checkpoint.mjs';

const SOURCE = EVENT_SOURCES.guidle;
const SITE_ORIGIN = 'https://www.guidle.com';
const SITEMAP_INDEX_URL = `${SITE_ORIGIN}/sitemapindex.xml`;
const LOCALES = ['it', 'en', 'de', 'fr'];

const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const FETCH_TIMEOUT_MS = 20000;
const SITEMAP_DELAY_MS = 300; // between sitemap shard fetches
const DETAIL_DELAY_MS = 400; // between guidle.com origin detail-page fetches
const RUN_BUDGET_MS = Number(process.env.GUIDLE_CRAWL_BUDGET_MS) || 8 * 60_000; // per-run wall-clock cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let detailFetchesOk = 0;

async function fetchText(url) {
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

async function fetchGzipText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return gunzipSync(buf).toString('utf-8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Sitemap parsing (pure — no network) ──────────────────────────────────

const SHARD_LOC_RE = /<loc>(https:\/\/www\.guidle\.com\/sitemap\d+\.xml\.gz)<\/loc>/g;

/** Extract the gzipped shard URLs out of `sitemapindex.xml`. */
export function parseSitemapIndexXml(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const out = [];
  SHARD_LOC_RE.lastIndex = 0;
  let m;
  while ((m = SHARD_LOC_RE.exec(xml))) out.push(m[1]);
  return out;
}

const EVENT_LOC_RE = /<loc>(https:\/\/www\.guidle\.com\/([a-z]{2})(\/[^<]*))<\/loc>/g;
const EVENT_CODE_RE = /_([A-Za-z0-9]{5,10})$/;

/**
 * Extract individual event detail URLs from one sitemap shard, deduped by
 * their trailing `_<code>` id (stable across every locale variant of the
 * same event — verified live, zero collisions across the full 119'800-url
 * corpus). Category/region listing and `/print` pages have no trailing code
 * and are filtered out. Returns `{ code, pathSuffix }` — `pathSuffix` is
 * everything after the 2-letter locale prefix (e.g.
 * `/veranstaltungen/zug/stadtfuehrung_AZ3RYEB`), reusable behind ANY of
 * it/en/de/fr (the language selector does not re-translate this segment).
 */
export function extractEventUrlsFromSitemapXml(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const out = [];
  const seen = new Set();
  EVENT_LOC_RE.lastIndex = 0;
  let m;
  while ((m = EVENT_LOC_RE.exec(xml))) {
    const pathSuffix = m[3];
    if (!pathSuffix || pathSuffix.includes('/print')) continue;
    const codeMatch = EVENT_CODE_RE.exec(pathSuffix);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, pathSuffix });
  }
  return out;
}

// ── Detail-page parsing (pure — no network) ──────────────────────────────

const LD_JSON_RE = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/**
 * Pick the schema.org Event occurrences off a detail page. A non-recurring
 * event's JSON-LD block is a single `{"@type":"Event",…}` object; a
 * recurring one is a JSON ARRAY of such objects, one per future occurrence
 * (verified live: an 18-item array for a weekly guided tour). Both shapes are
 * normalized here into a flat array (empty when no Event block is found).
 */
export function extractEventJsonLdOccurrences(html) {
  if (typeof html !== 'string' || !html) return [];
  LD_JSON_RE.lastIndex = 0;
  let match;
  while ((match = LD_JSON_RE.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue; // malformed block — keep scanning the rest of the page
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const events = list.filter((o) => o && typeof o === 'object' && o['@type'] === 'Event' && typeof o.startDate === 'string');
    if (events.length) return events;
  }
  return [];
}

/**
 * Summarize a list of Event occurrences into one {startDate, startTime,
 * endDate, recurring} record: earliest occurrence's date+time as the
 * canonical start, latest occurrence's date as the end, `recurring: true`
 * when there is more than one. guidle's JSON-LD dates have no timezone
 * suffix (e.g. `"2026-07-04T09:50"`) — they are already Europe/Zurich local
 * time, so no conversion is needed (unlike myswitzerland's UTC Algolia data).
 */
export function summarizeOccurrences(occurrences) {
  if (!Array.isArray(occurrences) || occurrences.length === 0) return null;
  const sorted = [...occurrences].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const startDate = String(first.startDate || '').slice(0, 10);
  if (!startDate) return null;
  const startTimeRaw = String(first.startDate || '').slice(11, 16);
  const startTime = /^\d{2}:\d{2}$/.test(startTimeRaw) ? startTimeRaw : undefined;
  const endRaw = last.endDate || last.startDate;
  const endDate = String(endRaw || '').slice(0, 10) || undefined;
  return { startDate, startTime, endDate, recurring: occurrences.length > 1 };
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function text(el) {
  return cleanText(el?.textContent || '');
}

/** {street, postalCode} from a JSON-LD `location.address` (PostalAddress), or undefined. */
export function extractAddress(address) {
  if (!address || typeof address !== 'object') return undefined;
  const street = typeof address.streetAddress === 'string' && address.streetAddress.trim() ? address.streetAddress.trim() : undefined;
  const postalCode = typeof address.postalCode === 'string' && address.postalCode.trim() ? address.postalCode.trim() : undefined;
  if (!street && !postalCode) return undefined;
  return { street, postalCode };
}

// Accordion h3 labels, per locale — DOM-scraped fields (category, price) are
// NOT in the JSON-LD, they live in `.accordion-wrap` blocks whose heading
// text is translated per locale (verified live for all 4).
const CATEGORY_LABELS = { it: 'Categoria', de: 'Kategorie', fr: 'Catégorie', en: 'Category' };
const PRICE_LABELS = { it: 'Prezzo', de: 'Preis', fr: 'Prix', en: 'Price' };

function findAccordion(doc, label) {
  if (!label) return null;
  for (const wrap of doc.querySelectorAll('.accordion-wrap')) {
    const h3 = wrap.querySelector('h3');
    if (h3 && text(h3) === label) return wrap.querySelector('.accordion');
  }
  return null;
}

/** First category `<li>` under the "Kategorie"/"Categoria"/… accordion, or undefined. */
export function extractCategory(doc, locale) {
  const acc = findAccordion(doc, CATEGORY_LABELS[locale]);
  const li = acc?.querySelector('li');
  const value = li ? text(li) : '';
  return value || undefined;
}

const FREE_RE = /\b(gratis|gratuit[oe]?|free|kostenlos|eintritt frei|entr[ée]e libre|ingresso libero)\b/i;
const AMOUNT_RE = /(\d+(?:[.,]\d{1,2})?)/g;

/**
 * Parse guidle's free-text price accordion (e.g. "CHF 10.00 pro Person…",
 * "Ingresso 20 franchi, Bambini gratis") into `{amount, currency, isFree}`.
 * Takes the CHEAPEST number found (same "cheapest of several prices" rule as
 * the myswitzerland crawler's `extractPrice`). Falls back to a free-keyword
 * match when no number is present, and to `amount: null` (price info exists
 * but isn't machine-parseable, e.g. "su richiesta" / "on request") otherwise.
 */
export function parsePriceText(rawText) {
  const t = cleanText(rawText);
  if (!t) return undefined;
  const numbers = [];
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(t))) {
    const n = Number.parseFloat(m[1].replace(',', '.'));
    if (Number.isFinite(n)) numbers.push(n);
  }
  if (numbers.length) {
    const amount = Math.min(...numbers);
    return { amount, currency: 'CHF', isFree: amount === 0 };
  }
  if (FREE_RE.test(t)) return { amount: 0, currency: 'CHF', isFree: true };
  return { amount: null, currency: 'CHF', isFree: false };
}

/** Price from the "Preis"/"Prezzo"/… accordion, or undefined when absent. */
export function extractPrice(doc, locale) {
  const acc = findAccordion(doc, PRICE_LABELS[locale]);
  if (!acc) return undefined;
  return parsePriceText(text(acc));
}

/**
 * Geo coordinates + canton from `<meta name="geo.position">` /
 * `<meta name="geo.region">` — both present on every real event detail page
 * (verified live). `geo.region` is a strong, source-provided canton signal
 * (`CH-ZG` → `ZG`) most sources don't have, used as `resolveComuneNationwide`'s
 * `cantonHint`.
 */
export function extractGeoAndCanton(doc) {
  const geoContent = doc.querySelector('meta[name="geo.position"]')?.getAttribute('content') || '';
  const [latStr, lngStr] = geoContent.split(';');
  const lat = Number.parseFloat(latStr);
  const lng = Number.parseFloat(lngStr);
  const geo = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;

  const regionContent = doc.querySelector('meta[name="geo.region"]')?.getAttribute('content') || '';
  const cantonMatch = /^CH-([A-Za-z]{2})$/.exec(regionContent.trim());
  const canton = cantonMatch ? cantonMatch[1].toUpperCase() : undefined;

  return { geo, canton };
}

/**
 * Pure mapping: one fetched detail page (a single locale variant of one
 * event) → a flat data record. Never touches the network. Returns `null`
 * when the page has no usable Event JSON-LD (missing/expired/wrong page).
 */
export function mapDetailPageToLocaleData(html, locale) {
  const occurrences = extractEventJsonLdOccurrences(html);
  const summary = summarizeOccurrences(occurrences);
  if (!summary) return null;
  const first = occurrences[0];
  const title = cleanText(first.name);
  if (!title) return null;
  const description = cleanText(first.description) || undefined;
  const venue = cleanText(first.location?.name) || undefined;
  const address = extractAddress(first.location?.address);
  const addressLocality = cleanText(first.location?.address?.addressLocality) || undefined;
  const imageSourceUrl = typeof first.image === 'string' && first.image.trim() ? first.image.trim() : undefined;

  const doc = new JSDOM(html).window.document;
  const category = extractCategory(doc, locale);
  const price = extractPrice(doc, locale);
  const { geo, canton } = extractGeoAndCanton(doc);

  return {
    title,
    description,
    ...summary,
    venue,
    address,
    addressLocality,
    imageSourceUrl,
    category,
    price,
    geo,
    canton,
  };
}

/**
 * Pure merge: per-locale detail-page data (up to 4, one per it/en/de/fr,
 * `null` for a locale that 404s/410s/has no usable Event) → a SiteEvent-shaped
 * record. Structured fields (dates, category, price, geo, canton, venue,
 * address, image) come from the FIRST locale (in it→en→de→fr order) that has
 * data — they don't vary by locale, only the text does.
 * `titleByLocale`/`descriptionByLocale` collect the REAL text of every locale
 * that resolved, which is honestly identical to the source language for
 * events an organizer never translated (not a bug — see file header).
 * Returns `null` when every locale is unusable (event fully gone).
 */
export function mapGuidleEvent(code, localeResults) {
  const primaryLocale = LOCALES.find((l) => localeResults[l]);
  if (!primaryLocale) return null;
  const primary = localeResults[primaryLocale];

  const titleByLocale = {};
  const descriptionByLocale = {};
  for (const locale of LOCALES) {
    const d = localeResults[locale];
    if (!d) continue;
    if (d.title) titleByLocale[locale] = d.title;
    if (d.description) descriptionByLocale[locale] = d.description;
  }

  return {
    event: {
      id: eventStableId(SOURCE.key, code),
      title: primary.title,
      titleByLocale: Object.keys(titleByLocale).length ? titleByLocale : undefined,
      description: primary.description,
      descriptionByLocale: Object.keys(descriptionByLocale).length ? descriptionByLocale : undefined,
      startDate: primary.startDate,
      endDate: primary.endDate,
      startTime: primary.startTime,
      category: primary.category || 'Event',
      venue: primary.venue,
      comune: undefined,
      canton: '',
      url: primary.url,
      sourceKey: SOURCE.key,
      sourceName: SOURCE.label,
      price: primary.price,
      address: primary.address,
      geo: primary.geo,
      recurring: primary.recurring,
    },
    imageSourceUrl: primary.imageSourceUrl,
    addressLocality: primary.addressLocality,
    cantonHint: primary.canton,
  };
}

// ── Network orchestration ────────────────────────────────────────────────

/**
 * Walk the sitemap index + shards, collecting `{code -> pathSuffix}` for
 * every individual event, stopping early once `limit` distinct events are
 * found (fast path for `--limit` local iteration — a full run has no limit
 * and always walks every shard).
 */
async function collectEventUrls(limit) {
  const indexXml = await fetchText(SITEMAP_INDEX_URL);
  if (!indexXml) return { entries: [], shardsOk: 0, shardsFailed: 0 };
  const shardUrls = parseSitemapIndexXml(indexXml);

  const byCode = new Map();
  let shardsOk = 0;
  let shardsFailed = 0;
  for (const shardUrl of shardUrls) {
    const xml = await fetchGzipText(shardUrl);
    await sleep(SITEMAP_DELAY_MS);
    if (!xml) {
      shardsFailed += 1;
      continue;
    }
    shardsOk += 1;
    for (const { code, pathSuffix } of extractEventUrlsFromSitemapXml(xml)) {
      if (!byCode.has(code)) byCode.set(code, pathSuffix);
    }
    if (limit && byCode.size >= limit) break;
  }

  const entries = [...byCode.entries()];
  return { entries: limit ? entries.slice(0, limit) : entries, shardsOk, shardsFailed };
}

/**
 * Returns `{ htmlOk, data }` — `htmlOk` is true whenever real HTML came back
 * (independent of parse outcome) and is the signal callers use to tell
 * "page genuinely unreachable" (htmlOk=false, safe to treat as gone) apart
 * from "page loaded fine but our parser couldn't extract anything from it"
 * (htmlOk=true, data=null — a structural-drift signal, NOT evidence the
 * event is gone; must never feed into `goneIds`).
 */
async function fetchLocaleData(pathSuffix, locale) {
  const url = `${SITE_ORIGIN}/${locale}${pathSuffix}`;
  const html = await fetchText(url);
  await sleep(DETAIL_DELAY_MS);
  if (!html) return { htmlOk: false, data: null };
  detailFetchesOk += 1; // positive success signal — HTML came back, independent of parse outcome
  const mapped = mapDetailPageToLocaleData(html, locale);
  return { htmlOk: true, data: mapped ? { ...mapped, url } : null };
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
  const deadline = Date.now() + RUN_BUDGET_MS;

  const { entries, shardsOk, shardsFailed } = await collectEventUrls(limit);
  console.log(`[guidle] sitemap: ${shardsOk} shard(s) ok, ${shardsFailed} failed, ${entries.length} unique event(s) in catalog`);

  const startIndex = limit ? 0 : loadCursor(SOURCE.key) % Math.max(entries.length, 1);
  if (!limit && startIndex > 0) {
    console.log(`[guidle] resuming from checkpoint index ${startIndex}/${entries.length}`);
  }

  const events = [];
  const goneIds = [];
  let goneEverywhere = 0;
  let driftSuspected = 0;
  let resolvedComune = 0;
  let visited = 0;
  let cursor = startIndex;

  while (visited < entries.length) {
    if (!limit && Date.now() >= deadline) {
      console.log(
        `[guidle] time budget (${RUN_BUDGET_MS}ms) reached after ${visited}/${entries.length} event(s) — stopping, will resume next run`,
      );
      break;
    }

    const [code, pathSuffix] = entries[cursor];
    const localeResults = {};
    let anyHtmlOk = false;
    for (const locale of LOCALES) {
      const { htmlOk, data } = await fetchLocaleData(pathSuffix, locale);
      if (htmlOk) anyHtmlOk = true;
      localeResults[locale] = data;
    }

    const mapped = mapGuidleEvent(code, localeResults);
    if (!mapped) {
      if (anyHtmlOk) {
        // Real HTML came back for at least one locale but nothing parsed —
        // a drift signal, not evidence the event is gone. Leave it out of
        // this run's contribution (neither added nor removed); the
        // aggregate detailFetchesOk-based guard below surfaces the drift.
        driftSuspected += 1;
      } else {
        goneEverywhere += 1;
        goneIds.push(eventStableId(SOURCE.key, code));
      }
    } else {
      const { event, imageSourceUrl, addressLocality, cantonHint } = mapped;
      const { comune, canton } = resolveComuneNationwide(
        { venue: [event.venue, addressLocality].filter(Boolean).join(' '), title: event.title, region: undefined },
        cantonHint,
      );
      event.comune = comune || undefined;
      event.canton = canton || cantonHint || '';
      if (event.comune) resolvedComune += 1;
      event.imageUrl = (await mirrorEventImage(imageSourceUrl, event.id)) || undefined;
      events.push(event);
    }

    visited += 1;
    cursor = (cursor + 1) % entries.length;
  }

  console.log(
    `[guidle] visited ${visited}/${entries.length} event(s) this run — ${events.length} mapped (${goneEverywhere} expired/gone, ` +
      `${driftSuspected} suspected drift) — comune resolved ${resolvedComune}/${events.length}`,
  );
  if (driftSuspected > 0) {
    console.warn(
      `[guidle] ${driftSuspected} event(s) returned real HTML but failed to parse — left untouched in the slice this run, check JSON-LD/DOM selectors for partial drift`,
    );
  }

  if (dryRun) {
    console.log('🏃 dry-run — slice/checkpoint not written');
    console.log(JSON.stringify(events.slice(0, 3), null, 2));
    return;
  }

  if (!limit && entries.length > 0) saveCursor(SOURCE.key, cursor, crawledAt);

  if (events.length === 0 && goneIds.length === 0) {
    // Never overwrite a good slice with an empty run. Distinguish two causes:
    //  - no detail page returned real HTML this run (network/WAF) → transient, soft-exit 0.
    //  - detail pages loaded fine but nothing mapped to a valid event → likely
    //    structural drift (JSON-LD/DOM markup changed); exit non-zero so
    //    crawl-events.yml opens a failure issue instead of the dataset going
    //    silently stale. Mirrors crawl-tio-agenda.mjs's pagesOk>0 pattern —
    //    a positive success signal, not a cumulative failure counter (a
    //    cumulative counter is almost always >0 at guidle's real scale even
    //    when everything works, since some per-locale fetches always miss).
    console.log('[guidle] 0 events mapped this run — leaving existing slice untouched');
    if (detailFetchesOk === 0) {
      console.log('[guidle] no detail pages loaded successfully this run — transient, soft-exit 0');
    } else {
      console.error(`[guidle] ${detailFetchesOk} detail page(s) returned HTML but yielded 0 events — check JSON-LD/DOM selectors for drift`);
      process.exitCode = 1;
    }
    return;
  }

  const slicePath = path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`);
  const total = mergeEventsIntoSlice({
    slicePath,
    sourceKey: SOURCE.key,
    sourceName: SOURCE.label,
    freshEvents: events,
    goneIds,
    crawledAt,
  });
  console.log(
    `[guidle] merged ${events.length} event(s) (${goneIds.length} removed) → ${total} total in ${path.relative(process.cwd(), slicePath)}`,
  );
}

// Only crawl when invoked directly (`node scripts/crawl-guidle-events.mjs`),
// so tests can import the pure parsing/mapping functions without triggering a
// live crawl.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[guidle] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
