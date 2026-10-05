#!/usr/bin/env node
/**
 * Crawler — classicAscona (Settimane Musicali di Ascona), canton TI, on the
 * shared `createAgendaCrawler` factory (scripts/lib/agenda-crawler-factory.mjs).
 *
 * Owner decisions of 2026-10-05:
 *   - D3 «solo fatti»: the organizer publishes no licence and no prohibition,
 *     so only facts are kept — title, date and time, venue and address,
 *     performer names, the structured price and the link to the concert page.
 *     The organizer's description and images are NEVER copied: the
 *     description below is our own text, built from those facts in it/en/de/fr.
 *   - D4: the JSON-LD `offers` is an admitted price field for this source
 *     (`EVENT_PRICE_FIELD_RULES.classicascona`): «from CHF X» for the minimum of
 *     an AggregateOffer, a single price for an Offer. Free concerts publish no
 *     structured price and stay without one.
 *
 * Reads (robots.txt allows both, no Crawl-delay; we still wait ≥ 2 s between
 * requests):
 *   1. the concert sitemap https://classicascona.ch/konzerte-sitemap1.xml —
 *      Italian pages `/concerti/<slug>/` only (the de/en twins are the same
 *      concerts under other URLs and are not crawled, so no concert gets two ids);
 *   2. the schema.org `MusicEvent` JSON-LD of each concert page.
 * A concert already in the slice whose date is past is not fetched again.
 *
 * Price cross-check: the structured amounts must appear in the «Categorie di
 * prezzo» tariffs the page shows (CHF 85 / 70 / 55 / 40); otherwise — card
 * missing included — the price is dropped and a line is logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgendaCrawler } from './lib/agenda-crawler-factory.mjs';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  eventStableId,
  hasConfidentPrice,
  loadCantonComuni,
  resolveComune,
} from './lib/events-utils.mjs';
import {
  extractEventNodes,
  extractOrganizerOfferPrice,
  ldLocation,
  ldPersonNames,
  ldText,
  parseLocalDateTime,
} from './lib/organizer-jsonld.mjs';
import { failIfSourceUnreachable } from './lib/icms-agenda.mjs';

const SOURCE = EVENT_SOURCES.classicascona;
export const SITEMAP_URL = 'https://classicascona.ch/konzerte-sitemap1.xml';
export const POLITE_DELAY_MS = 2000;
const CONCERT_URL_RE = /^https:\/\/classicascona\.ch\/concerti\/([a-z0-9][a-z0-9-]*)\/$/;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Italian concert pages of the sitemap, in sitemap order, without duplicates. */
export function parseConcertSitemap(xml) {
  const urls = [];
  for (const match of String(xml ?? '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const url = match[1].replace(/&amp;/g, '&');
    if (CONCERT_URL_RE.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** `<slug>` of a concert page URL, or ''. */
export function concertSlug(url) {
  return CONCERT_URL_RE.exec(String(url ?? ''))?.[1] || '';
}

/**
 * Tariffs the page shows under «Categorie di prezzo» (`CHF 85 / 70 / 55 / 40`),
 * or undefined when the block is missing. `CHF 0` gives `[0]`.
 */
export function shownTariffs(html) {
  const text = String(html ?? '');
  const label = text.search(/>\s*Categorie di prezzo\s*</i);
  if (label === -1) return undefined;
  const heading = /card-info__heading[^>]*>([^<]*)</i.exec(text.slice(label, label + 4000));
  if (!heading) return undefined;
  const tariffs = [...ldText(heading[1]).matchAll(/\d+(?:[.,]\d{1,2})?/g)]
    .map((match) => Number(match[0].replace(',', '.')))
    .filter(Number.isFinite);
  return tariffs.length ? tariffs : undefined;
}

const DESCRIPTION_LOCALES = {
  it: { tag: 'it-CH', at: 'alle', performers: 'Interpreti', series: 'concerto delle Settimane Musicali di Ascona (classicAscona)', on: '', more: 'Programma, biglietti e dettagli sulla pagina del concerto.', sep: ': ' },
  en: { tag: 'en-GB', at: 'at', performers: 'Performers', series: 'a concert of the Ascona Music Weeks (classicAscona)', on: 'on ', more: 'Programme, tickets and details on the concert page.', sep: ': ' },
  de: { tag: 'de-CH', at: 'um', performers: 'Mitwirkende', series: 'Konzert der Musikwochen Ascona (classicAscona)', on: 'am ', more: 'Programm, Tickets und Details auf der Konzertseite.', sep: ': ', timeSuffix: ' Uhr' },
  fr: { tag: 'fr-CH', at: 'à', performers: 'Interprètes', series: 'concert des Semaines musicales d’Ascona (classicAscona)', on: 'le ', more: 'Programme, billets et détails sur la page du concert.', sep: ' : ' },
};

/** «mercoledì 7 ottobre 2026», «Mittwoch, 7. Oktober 2026» (comma only where usual). */
function longDate(day, tag) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'long', timeZone: 'UTC' }).format(date);
  const dayMonthYear = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  return `${weekday}${tag.startsWith('de') ? ',' : ''} ${dayMonthYear}`;
}

/**
 * Our own description of a concert, in it/en/de/fr, from facts only (title,
 * date, time, venue, performer names). No organizer text, no price (the
 * price line shows the structured price, H5).
 */
export function concertDescriptionByLocale({ title, startDate, startTime, venue, locality, performers = [] }) {
  const out = {};
  for (const [locale, copy] of Object.entries(DESCRIPTION_LOCALES)) {
    const when = `${copy.on}${longDate(startDate, copy.tag)}${startTime ? ` ${copy.at} ${startTime}${copy.timeSuffix || ''}` : ''}`;
    const place = [venue, locality && !(venue || '').includes(locality) ? locality : ''].filter(Boolean).join(', ');
    const parts = [`${title}${copy.sep}${copy.series}, ${when}${place ? `, ${place}` : ''}.`];
    if (performers.length) parts.push(`${copy.performers}${copy.sep}${performers.join(', ')}.`);
    parts.push(copy.more);
    out[locale] = parts.join(' ');
  }
  return out;
}

/**
 * One concert page → `[event]` (or `[]` when the page has no usable Event
 * JSON-LD). Exported so tests run on recorded pages without a network.
 *
 * @param {string} html
 * @param {string} pageUrl - the `/concerti/<slug>/` URL the page was read from.
 * @param {{ log?: (line: string) => void, comuni?: string[] }} [options]
 */
export function parseConcertPage(html, pageUrl, { log = console.warn, comuni = loadCantonComuni(SOURCE.canton) } = {}) {
  const slug = concertSlug(pageUrl);
  if (!slug) return [];
  const ld = extractEventNodes(html)[0];
  if (!ld) return [];
  const title = ldText(ld.name);
  const start = parseLocalDateTime(ld.startDate);
  if (!title || !start) return [];
  if (/EventCancelled/i.test(String(ld.eventStatus || ''))) {
    log(`[${SOURCE.key}] ${slug}: cancelled, skipped`);
    return [];
  }

  const { venue, address = {}, country } = ldLocation(ld.location);
  if (country && country !== 'CH') return [];
  const { comune, method } = resolveComune({ venue: `${address.locality || ''} ${venue || ''}`, title: '' }, comuni);
  const performers = ldPersonNames(ld.performer);
  const organizerName = ldPersonNames(ld.organizer)[0];

  const priced = extractOrganizerOfferPrice(ld, {
    priceSource: SOURCE.key,
    // No visible tariff card → nothing to cross-check against → no price.
    shownTariffs: shownTariffs(html) ?? [],
    baseUrl: pageUrl,
  });
  if (priced?.rejected) log(`[${SOURCE.key}] ${slug}: price dropped — ${priced.rejected}`);
  const price = priced?.price && hasConfidentPrice(priced.price) ? priced.price : undefined;

  const descriptionByLocale = concertDescriptionByLocale({
    title, startDate: start.day, startTime: start.time, venue, locality: address.locality, performers,
  });

  // endDate is deliberately not read: in 7 of 7 sampled pages it is a
  // synthetic start + 2 h, while the stated durations are 60′ and 100′.
  return [{
    id: eventStableId(SOURCE.key, slug),
    title,
    startDate: start.day,
    ...(start.time ? { startTime: start.time } : {}),
    category: 'musica',
    description: descriptionByLocale.it,
    descriptionByLocale,
    ...(venue ? { venue } : {}),
    ...(Object.keys(address).length ? { address } : {}),
    ...(comune ? { comune, comuneMatch: method } : {}),
    canton: SOURCE.canton,
    url: pageUrl,
    ...(price ? { price } : {}),
    ...(performers.length ? { performer: performers.map((name) => ({ '@type': 'Person', name })) } : {}),
    ...(organizerName ? { organizer: { '@type': 'Organization', name: organizerName } } : {}),
  }];
}

/**
 * Concert URLs worth fetching: everything in the sitemap except the concerts
 * already in the slice with a start date before `today` (a past concert does
 * not change, and refetching the whole edition every day is pointless load).
 */
export function urlsToFetch(sitemapUrls, sliceEvents, today) {
  const past = new Set(
    (sliceEvents || [])
      .filter((event) => typeof event?.startDate === 'string' && event.startDate < today)
      .map((event) => event.url),
  );
  return sitemapUrls.filter((url) => !past.has(url));
}

/**
 * The factory crawler over a list of concert pages: one page per iteration,
 * ≥ 2 s apart, no image mirroring (D3: organizer images are not reused).
 * `fetchImpl`, `sliceDir` and `politeDelayMs` are injectable for tests.
 */
export function createClassicAsconaCrawler(urls, { fetchImpl, sliceDir, politeDelayMs = POLITE_DELAY_MS } = {}) {
  return createAgendaCrawler({
    sourceKey: SOURCE.key,
    baseUrl: (i) => urls[i],
    parseDayHtml: (html, i) => parseConcertPage(html, urls[i]),
    iterations: urls.length,
    politeDelayMs,
    mirrorImages: false,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sliceDir ? { sliceDir } : {}),
  });
}

function readSliceEvents(slicePath) {
  if (!existsSync(slicePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(slicePath, 'utf-8'));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) {
    console.error(`[${SOURCE.key}] sitemap unreachable: ${SITEMAP_URL} — previous slice kept`);
    process.exitCode = 1;
    return;
  }
  const sitemapUrls = parseConcertSitemap(xml);
  if (!sitemapUrls.length) {
    console.error(`[${SOURCE.key}] sitemap has no /concerti/<slug>/ page — format changed? previous slice kept`);
    process.exitCode = 1;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const urls = urlsToFetch(sitemapUrls, readSliceEvents(path.join(EVENTS_SLICE_DIR, `${SOURCE.key}.json`)), today);
  console.log(`[${SOURCE.key}] sitemap: ${sitemapUrls.length} concert page(s), ${urls.length} to read (the others are past concerts already in the slice)`);
  if (!urls.length) return;
  await sleep(POLITE_DELAY_MS);

  const result = await createClassicAsconaCrawler(urls).crawl({ dryRun });
  failIfSourceUnreachable(SOURCE.key, result);
  const withPrice = result.events.filter((event) => hasConfidentPrice(event.price)).length;
  console.log(`[${SOURCE.key}] ${result.events.length} concert(s) read, ${withPrice} with a publishable structured price`);
  if (dryRun) console.log(JSON.stringify(result.events.slice(0, 3), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[${SOURCE.key}] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
