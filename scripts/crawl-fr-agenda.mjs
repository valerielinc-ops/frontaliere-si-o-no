#!/usr/bin/env node
/**
 * Crawler — Etat de Fribourg agenda (events, canton FR), on the shared
 * `createAgendaCrawler` factory (scripts/lib/agenda-crawler-factory.mjs).
 *
 * Source: https://www.fr.ch/evenements/rss.xml, the State of Fribourg's own
 * events feed (P9a, sezioni cantonali: verified by the FR source survey on
 * 2026-10-05, robots.txt `User-agent: *` without any rule on this path and no
 * AI-bot block). Unlike a news feed, each `<item>` is an EVENT with
 * structured fields in the `event:` / `georss:` namespaces:
 *
 *   <event:startDate>2026-10-10T13:30:00+02:00</event:startDate>
 *   <event:endDate>2026-10-10T18:00:00+02:00</event:endDate>   (optional)
 *   <event:address1>Wilerweg 53</event:address1>
 *   <event:postalCode>3280</event:postalCode>
 *   <event:city>Murten</event:city>
 *   <event:gps>46.9232041,7.1240511</event:gps>
 *   <event:eventType>Manifestation</event:eventType>
 *   <enclosure url="…png" type="image/png" />
 *
 * so nothing is parsed out of prose: an item without a usable
 * `event:startDate` is skipped and counted, never given a guessed date.
 * The feed is one document (≈80 items, all upcoming), so the factory runs a
 * single iteration. The German twin feed (/de/evenements/rss.xml) lists the
 * same events under different URLs; it is not crawled, so no event is
 * indexed twice under two ids.
 *
 * Dates: the date part is read in the feed's own offset (local Swiss time),
 * exactly as written — never shifted through UTC, which would move a 00:30
 * event to the previous day.
 */
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { createAgendaCrawler } from './lib/agenda-crawler-factory.mjs';
import { EVENT_SOURCES, eventStableId, loadCantonComuni, resolveComune, cleanEventText } from './lib/events-utils.mjs';

const SOURCE = EVENT_SOURCES['fr-agenda'];
export const FEED_URL = 'https://www.fr.ch/evenements/rss.xml';
const ORIGIN = 'https://www.fr.ch';

const ISO_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/;

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return textOf(value['#text']);
  return String(value);
}

/** Tags stripped and entities decoded by the shared boundary (cleanEventText). */
function plain(value) {
  return cleanEventText(textOf(value));
}

function isValidIsoDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** `2026-10-10T13:30:00+02:00` → `{ day: '2026-10-10', time: '13:30' }`, or null. */
export function parseFeedDateTime(raw) {
  const match = ISO_LOCAL_RE.exec(String(raw || '').trim());
  if (!match || !isValidIsoDay(match[1])) return null;
  const time = `${match[2]}:${match[3]}`;
  // Drupal writes a date-only event as local midnight; 00:00 carries no time.
  return { day: match[1], time: time === '00:00' ? undefined : time };
}

/** `46.9232041,7.1240511` → `{ lat, lng }` inside a sane WGS84 range, or undefined. */
export function parseFeedGps(raw) {
  const parts = String(raw || '').split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return undefined;
  const [lat, lng] = parts;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}

function rawIdFromLink(link) {
  try {
    const url = new URL(link, ORIGIN);
    if (url.hostname !== 'www.fr.ch') return '';
    return url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse the feed into event objects. Exported so tests cover the real item
 * markup (fixture XML) without a live fetch.
 */
export function parseFribourgEventsFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
  });
  let doc;
  try {
    doc = parser.parse(String(xml || ''));
  } catch {
    return [];
  }
  const items = asArray(doc?.rss?.channel?.item);
  const comuni = loadCantonComuni(SOURCE.canton);
  const events = [];
  let skippedNoDate = 0;

  for (const item of items) {
    const link = textOf(item?.link).trim();
    const rawId = rawIdFromLink(link);
    const title = plain(item?.title);
    if (!rawId || !title) continue;

    const start = parseFeedDateTime(textOf(item?.['event:startDate']));
    if (!start) {
      skippedNoDate += 1;
      continue;
    }
    const end = parseFeedDateTime(textOf(item?.['event:endDate']));
    const endDay = end && end.day > start.day ? end.day : undefined;

    const city = plain(item?.['event:city']);
    const street = plain(item?.['event:address1']);
    const postalCode = plain(item?.['event:postalCode']);
    const address = {
      ...(street ? { street } : {}),
      ...(/^\d{4}$/.test(postalCode) ? { postalCode } : {}),
      ...(city ? { locality: city } : {}),
    };
    const { comune, method } = resolveComune({ venue: city, title }, comuni);
    const creator = plain(item?.['dc:creator']);
    const enclosure = asArray(item?.enclosure).find((entry) => /^image\//i.test(String(entry?.type || '')));
    const imageUrl = enclosure?.url && /^https?:\/\//i.test(enclosure.url) ? enclosure.url : undefined;
    const description = plain(item?.description);
    const category = plain(item?.['event:eventType']);
    const geo = parseFeedGps(textOf(item?.['event:gps']));

    events.push({
      id: eventStableId(SOURCE.key, rawId),
      title,
      startDate: start.day,
      ...(endDay ? { endDate: endDay } : {}),
      ...(start.time ? { startTime: start.time } : {}),
      ...(category ? { category } : {}),
      ...(description ? { description } : {}),
      ...(city ? { venue: city } : {}),
      ...(comune ? { comune, comuneMatch: method } : {}),
      canton: SOURCE.canton,
      url: link,
      ...(imageUrl ? { imageUrl } : {}),
      ...(Object.keys(address).length ? { address } : {}),
      ...(geo ? { geo } : {}),
      ...(creator ? { organizer: { '@type': 'Organization', name: creator } } : {}),
    });
  }

  if (skippedNoDate > 0) {
    console.warn(`[${SOURCE.key}] skipped ${skippedNoDate} item(s) without a usable event:startDate`);
  }
  return events;
}

const crawler = createAgendaCrawler({
  sourceKey: SOURCE.key,
  baseUrl: () => FEED_URL,
  parseDayHtml: (xml) => parseFribourgEventsFeed(xml),
  iterations: 1,
});

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const { events } = await crawler.crawl({ dryRun });
  if (dryRun) console.log(JSON.stringify(events.slice(0, 3), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[${SOURCE.key}] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
