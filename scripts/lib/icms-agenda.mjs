/**
 * Parsers for cantonal/municipal agendas published on the iCMS platform
 * (i-web.ch hosting: nw.ch, ow.ch, stadtluzern.ch, …) — P9a, sezioni
 * cantonali, sources verified by the 2026-10-05 survey. Two structured
 * shapes, no prose parsing:
 *
 *  1. "Anlässe" listing pages (`/anlaesseaktuelles`): the visible table is
 *     rendered client-side from a JSON payload in the `data-entities`
 *     attribute of the list element. Each row carries `id`, `name` (an
 *     anchor to `/_rte/anlass/<id>`), `_datumVon` / `_datumBis` (ISO days),
 *     `_anlassTime` ("13.30 Uhr", optional), `_ort` (locality, sometimes
 *     prefixed by its postal code), `lokalitaet` (venue) and `organisator`.
 *     Reading the payload is reading the data the page itself renders.
 *  2. Event RSS (`/aktuelles/termine.rss`): RSS 2.0 with the RSS event
 *     module (`ev:startdate` "YYYY-MM-DD[ HH:MM:SS]", `ev:enddate`).
 *     The `<author>` element carries a staff e-mail/phone: never read.
 *
 * A row/item without a valid start day is skipped and counted, never given a
 * guessed date. Exported pure functions: tests run on fixtures, no network.
 */

import { JSDOM } from 'jsdom';
import { XMLParser } from 'fast-xml-parser';
import { eventStableId, cleanEventText, resolveComuneNationwide, resolveComune, loadCantonComuni } from './events-utils.mjs';

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIsoDay(value) {
  const match = ISO_DAY_RE.exec(String(value || '').trim());
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? match[0] : null;
}

/**
 * Wall-clock time guard shared by the cantonal agenda parsers (fr.ch and
 * iCMS): hours 00–23, minutes 00–59. An event whose source time is out of
 * range is rejected, never published with an impossible `startTime`.
 */
export function isValidClockTime(hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** "13.30 Uhr" / "9.00 Uhr" / "13:30" → "13:30"; anything else → undefined. */
export function parseIcmsTime(raw) {
  const match = /^\s*(\d{1,2})[.:](\d{2})(?:\s*Uhr)?\s*$/i.exec(String(raw || ''));
  if (!match) return undefined;
  if (!isValidClockTime(match[1], match[2])) return undefined;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

/** "6370 Stans" → "Stans"; trims stray whitespace. */
function localityName(raw) {
  return cleanEventText(String(raw || '')).replace(/^\d{4,5}\s+/, '').trim();
}

/**
 * Canton/comune of a row listed by `sourceCanton`'s own agenda: the locality
 * is first matched against that canton's comuni, then nationwide (a NW agenda
 * can list an event in Sachseln, OW), and only when neither names a comune
 * does the agenda's own canton stand (the canton-hint rule of
 * `resolveComuneNationwide`). Only the locality is matched — never the
 * title, where a comune name is often just a topic.
 */
function attributeLocality(locality, sourceCanton) {
  const { comune, canton, method } = resolveComuneNationwide({ venue: locality, title: '' }, sourceCanton);
  return { comune: comune || undefined, comuneMatch: method || undefined, canton: canton || sourceCanton };
}

function absoluteUrl(href, origin) {
  try {
    const url = new URL(href, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse an iCMS "Anlässe" page into events.
 * @param {string} html
 * @param {{ sourceKey: string, canton: string, origin: string }} source
 */
export function parseIcmsAnlaesseHtml(html, { sourceKey, canton, origin }) {
  const dom = new JSDOM(String(html || ''));
  const events = [];
  let skippedNoDate = 0;
  try {
    const doc = dom.window.document;
    for (const el of doc.querySelectorAll('[data-entities]')) {
      let payload;
      try {
        payload = JSON.parse(el.getAttribute('data-entities') || '');
      } catch {
        continue;
      }
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      // Only the events table: news tables on the same platform share the
      // attribute but have no `_datumVon`.
      if (!rows.some((row) => row && '_datumVon' in row)) continue;
      for (const row of rows) {
        const rawId = String(row?.id || '').trim();
        if (!/^\d+$/.test(rawId)) continue;
        const nameDom = JSDOM.fragment(String(row.name || ''));
        const title = cleanEventText(nameDom.textContent || '');
        if (!title) continue;
        const startDate = validIsoDay(row._datumVon);
        if (!startDate) {
          skippedNoDate += 1;
          continue;
        }
        const endDay = validIsoDay(row._datumBis);
        const href = nameDom.querySelector('a[href]')?.getAttribute('href') || `/_rte/anlass/${rawId}`;
        const locality = localityName(row._ort || row.ort);
        const venueName = cleanEventText(String(row.lokalitaet || ''));
        const organizer = cleanEventText(String(row.organisator || ''));
        const startTime = parseIcmsTime(row._anlassTime);
        events.push({
          id: eventStableId(sourceKey, rawId),
          title,
          startDate,
          ...(endDay && endDay > startDate ? { endDate: endDay } : {}),
          ...(startTime ? { startTime } : {}),
          ...(venueName || locality ? { venue: [venueName, locality].filter(Boolean).join(', ') } : {}),
          ...attributeLocality(locality || venueName, canton),
          url: absoluteUrl(href, origin),
          ...(locality ? { address: { locality } } : {}),
          ...(organizer ? { organizer: { '@type': 'Organization', name: organizer } } : {}),
        });
      }
    }
  } finally {
    dom.window.close();
  }
  if (skippedNoDate > 0) console.warn(`[${sourceKey}] skipped ${skippedNoDate} row(s) without a valid _datumVon`);
  return events;
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return textOf(value['#text']);
  return String(value);
}

/** "2026-10-09 12:00:00" / "2026-10-03 " → { day, time } or null (invalid day or time). */
export function parseRssEventDate(raw) {
  const match = /^\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(raw || ''));
  const day = match && validIsoDay(match[1]);
  if (!day) return null;
  if (match[2] !== undefined && !isValidClockTime(match[2], match[3])) return null;
  const time = match[2] ? `${match[2]}:${match[3]}` : undefined;
  return { day, time: time && time !== '00:00' ? time : undefined };
}

/**
 * Parse an iCMS events RSS (RSS event module) into events.
 * @param {string} xml
 * @param {{ sourceKey: string, canton: string }} source
 */
export function parseIcmsTermineRss(xml, { sourceKey, canton }) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, trimValues: true });
  let doc;
  try {
    doc = parser.parse(String(xml || ''));
  } catch {
    return [];
  }
  const rawItems = doc?.rss?.channel?.item;
  const items = rawItems === undefined ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
  const comuni = loadCantonComuni(canton);
  const events = [];
  let skippedNoDate = 0;
  for (const item of items) {
    const link = textOf(item?.link).trim();
    const rawId = /\/_rte\/anlass\/(\d+)/.exec(link)?.[1];
    const title = cleanEventText(textOf(item?.title));
    if (!rawId || !title) continue;
    const start = parseRssEventDate(textOf(item?.['ev:startdate']));
    if (!start) {
      skippedNoDate += 1;
      continue;
    }
    const end = parseRssEventDate(textOf(item?.['ev:enddate']));
    const descriptionHtml = textOf(item?.description);
    const description = cleanEventText(descriptionHtml);
    const imageUrl = /<img[^>]+src="(https:\/\/[^"]+)"/i.exec(descriptionHtml)?.[1];
    const { comune, method } = resolveComune({ venue: description, title }, comuni);
    events.push({
      id: eventStableId(sourceKey, rawId),
      title,
      startDate: start.day,
      ...(end && end.day > start.day ? { endDate: end.day } : {}),
      ...(start.time ? { startTime: start.time } : {}),
      ...(description ? { description } : {}),
      ...(comune ? { comune, comuneMatch: method } : {}),
      canton,
      url: link,
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  if (skippedNoDate > 0) console.warn(`[${sourceKey}] skipped ${skippedNoDate} item(s) without a valid ev:startdate`);
  return events;
}

/**
 * Exit status of a single-document agenda crawl. The shared factory treats a
 * run whose every fetch failed as transient (exit 0, previous slice kept);
 * for these one-document sources that would hide an outage indefinitely, so
 * an unreachable source fails the step (exit 1) — still without touching the
 * previous slice, which the factory never writes when nothing was parsed.
 * Returns true when the failure was flagged.
 */
export function failIfSourceUnreachable(sourceKey, result, setExitCode = (code) => { process.exitCode = code; }) {
  if (result && result.pagesOk === 0 && result.pagesFail > 0) {
    console.error(`[${sourceKey}] source unreachable: ${result.pagesFail} fetch(es) failed, previous slice kept`);
    setExitCode(1);
    return true;
  }
  return false;
}
