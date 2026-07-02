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
} from './lib/events-utils.mjs';

const SOURCE = EVENT_SOURCES['tio-agenda'];
const DAY_URL = (compact) => `https://www.tio.ch/agenda/day/${compact}`;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const FETCH_TIMEOUT_MS = 20000;
const POLITE_DELAY_MS = 600;

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

  if (dryRun) {
    console.log('🏃 dry-run — slice not written');
    console.log(JSON.stringify(events.slice(0, 3), null, 2));
    return;
  }

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

  mkdirSync(EVENTS_SLICE_DIR, { recursive: true });
  const slicePath = path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`);
  const slice = {
    schemaVersion: 1,
    sourceKey: SOURCE.key,
    sourceName: SOURCE.label,
    canton: SOURCE.canton,
    assembledAt: crawledAt,
    events,
  };
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
  console.log(`[tio-agenda] wrote ${events.length} events → ${path.relative(process.cwd(), slicePath)}`);
}

// Only crawl when invoked directly (`node scripts/crawl-tio-agenda.mjs`), so
// tests can import `parseDayHtml` without triggering a live fetch.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[tio-agenda] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
