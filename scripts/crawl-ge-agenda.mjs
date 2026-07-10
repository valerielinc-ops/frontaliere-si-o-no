#!/usr/bin/env node
/**
 * Crawler — Ville de Genève Agenda (events, pilot non-TI canton, GE).
 *
 * Issue #3644 (F2 of #3125): validates the reusable `createAgendaCrawler`
 * factory (scripts/lib/agenda-crawler-factory.mjs) on a second, non-Ticino
 * canton. Quota-free: plain fetch + jsdom, no API key.
 *
 * geneve.ch/agenda is the City of Geneva's own official events listing — a
 * Drupal "Views" page, PAGE-indexed (`?page=N`, 0-based, ~20 cards/page,
 * chronologically ascending, verified live) rather than day-indexed like
 * tio.ch. Each card carries: a detail-page link (its slug is the stable raw
 * id), a thumbnail, a free-text French date string, a title, a free-text
 * description (venue/address is embedded in the prose, no separate field),
 * and 1-2 "tags" paragraphs (audience/label tags, then a category).
 *
 * Date text has several observed shapes ("Lundi 6 juillet, 09h30", "Du 6 au
 * 10 juillet", "jusqu'au 2 août", "jusqu'au 3 septembre 2026", "2 et 3
 * août", "31 octobre et 1 novembre") — see `parseGeneveDateFr` below. A card
 * whose date genuinely can't be parsed is skipped and counted, never given
 * a fabricated date.
 *
 * Comune: the listing is entirely scoped to the single municipality
 * "Genève" (quartier names like "Eaux-Vives" only appear in a sidebar
 * facet, not inline on the card), so every card resolves via the
 * `REGION_TO_COMUNE['geneve'] = 'Genève'` fallback (extended in
 * events-utils.mjs for this pilot) — `resolveComune`'s own exact
 * venue/title match still takes priority if a different real GE comune name
 * happens to appear in the description text.
 *
 * Flyer images (no-hotlink policy): mirrored by the factory itself via the
 * shared `mirrorEventImage`, same as every other events crawler.
 */
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createAgendaCrawler } from './lib/agenda-crawler-factory.mjs';
import { EVENT_SOURCES, eventStableId, loadCantonComuni, resolveComune, isoDay } from './lib/events-utils.mjs';

const SOURCE = EVENT_SOURCES['ge-agenda'];
const ORIGIN = 'https://www.geneve.ch';
const PAGE_URL = (page) => `${ORIGIN}/agenda?page=${page}`;
const HORIZON_DAYS = 21;
// Safety ceiling: live pagination check (2026-07-06) reached the ~21-day
// horizon around page 15; comfortable margin above that so a slower news
// week never gets cut short before `horizonDays` actually kicks in.
const MAX_PAGES = 40;

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function stripAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIso(day, month, year) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// Reviewer adversarial check (#3644 PR review): the token scanner only range-
// checks day as 1-31, so "31 avril" would otherwise silently produce the
// non-existent 2026-04-31. Round-tripping through Date.UTC (which
// auto-normalizes out-of-range days, e.g. April 31 -> May 1) catches every
// invalid day/month combo, leap years included, since it's checked once the
// exact year is already known.
function isValidCalendarDate(day, month, year) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const MONTHS_FR = {
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
};

const GRACE_DAYS = 3;

/**
 * Infer a year for a bare day/month combo (no year in the source text):
 * prefer the CURRENT year unless that date would land more than
 * `GRACE_DAYS` in the past relative to `now` — geneve.ch/agenda never lists
 * past events (verified live), so a date that already happened a few days
 * ago more likely means "next year" than "we're looking at a stale event".
 */
function inferYear(day, month, now) {
  const year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getTime() < now.getTime() - GRACE_DAYS * 86400000) return year + 1;
  return year;
}

/**
 * Parse Ville de Genève's free-text agenda date string into
 * `{ startDate, endDate }` ISO (date-only) strings — `endDate === startDate`
 * for a single-day event. Returns `null` when the string can't be parsed
 * with reasonable confidence; callers MUST skip the card rather than
 * fabricate a guess.
 *
 * Exported for tests/crawl-ge-agenda.test.ts — pure string parsing, no live
 * network/DOM needed to cover every observed format.
 */
export function parseGeneveDateFr(rawText, now = new Date()) {
  if (!rawText || typeof rawText !== 'string') return null;
  let normalized = stripAccents(rawText).toLowerCase().replace(/’/g, "'");

  // Explicit year, if present: extract + strip BEFORE token-scanning so a
  // "2026" is never misread as a 1-2 digit day token.
  let explicitYear;
  const yearMatch = /\b(20\d{2})\b/.exec(normalized);
  if (yearMatch) {
    explicitYear = Number.parseInt(yearMatch[1], 10);
    normalized = normalized.replace(yearMatch[0], ' ');
  }

  // Strip time-of-day tokens ("09h30", "20h") BEFORE scanning day/month —
  // otherwise "09h30"'s leading digits could be misread as a bogus day.
  normalized = normalized.replace(/\d{1,2}h\d{0,2}/g, ' ');

  const isOpenEnded = /jusqu'?\s*au\b/.test(normalized);
  if (isOpenEnded) normalized = normalized.replace(/jusqu'?\s*au\b/, ' ');
  const isRange = !isOpenEnded && /\bdu\b/.test(normalized) && /\bau\b/.test(normalized);

  const TOKEN_RE = /(\d{1,2})(?:er)?(?:\s+([a-z]+))?/g;
  const tokens = [];
  let match;
  while ((match = TOKEN_RE.exec(normalized))) {
    const day = Number.parseInt(match[1], 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) continue;
    const monthWord = match[2] ? match[2].trim() : undefined;
    const month = monthWord && MONTHS_FR[monthWord] ? MONTHS_FR[monthWord] : undefined;
    tokens.push({ day, month });
  }
  if (tokens.length === 0) return null;

  // Right-to-left month inheritance: "Du 6 au 10 juillet" → token[0] (6)
  // borrows token[1]'s (10 juillet) month; "2 et 3 août" the same way.
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    if (!tokens[i].month) tokens[i].month = tokens[i + 1].month;
  }
  if (tokens.some((t) => !t.month)) return null; // no month found anywhere in the string

  // Per-token year: bump +1 each time month decreases vs. the previous
  // token, so a year-boundary range ("31 décembre et 1 janvier") doesn't
  // silently produce an (wrong) 11-month span.
  const offsets = [];
  let yearOffset = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (i > 0 && tokens[i].month < tokens[i - 1].month) yearOffset += 1;
    offsets[i] = yearOffset;
  }
  // Year inference anchors on the LAST token (the range's end): an ongoing
  // range ("Du 6 au 10 juillet" crawled on the 10th) has its start in the
  // past by design, and anchoring on the start rolled the whole event to
  // next year while it was still running. The end date is the only token
  // that tells whether the event is truly over.
  const lastIdx = tokens.length - 1;
  const baseYear = explicitYear
    || (inferYear(tokens[lastIdx].day, tokens[lastIdx].month, now) - offsets[lastIdx]);
  for (let i = 0; i < tokens.length; i += 1) {
    tokens[i].year = baseYear + offsets[i];
  }

  // Reject a non-existent calendar date (e.g. a mis-scanned "31 avril")
  // outright rather than silently fabricating it — skip-on-unparseable is
  // the same contract as every other bail-out in this function.
  if (tokens.some((t) => !isValidCalendarDate(t.day, t.month, t.year))) return null;

  const first = toIso(tokens[0].day, tokens[0].month, tokens[0].year);
  const last = toIso(tokens[tokens.length - 1].day, tokens[tokens.length - 1].month, tokens[tokens.length - 1].year);

  if (isOpenEnded) {
    // We don't know the real start — use the crawl day as an honest lower
    // bound (we DO know the event is running as of today, per "jusqu'au").
    const today = isoDay(now);
    return { startDate: today, endDate: last >= today ? last : today };
  }
  if (tokens.length > 1 || isRange) {
    return first <= last ? { startDate: first, endDate: last } : { startDate: last, endDate: first };
  }
  return { startDate: first, endDate: first };
}

function rawIdFromHref(href) {
  const cleaned = (href || '').split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  return cleaned.replace(/^agenda\//, '') || cleaned;
}

function absoluteUrl(href) {
  if (!href) return undefined;
  if (href.startsWith('http')) return href;
  return `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`;
}

/**
 * Parse one `?page=N` listing page into event objects. Exported so tests
 * cover the real card markup (fixture HTML) without a live fetch.
 */
export function parseGeneveAgendaHtml(html, page, now = new Date()) {
  const doc = new JSDOM(html).window.document;
  const comuni = loadCantonComuni(SOURCE.canton);
  const events = [];
  let skippedNoDate = 0;

  for (const card of doc.querySelectorAll('article.event')) {
    const a = card.querySelector('a[href]');
    const href = a?.getAttribute('href') || '';
    if (!href) continue;
    const rawId = rawIdFromHref(href);
    if (!rawId) continue;

    const title = text(card.querySelector('h3.titre'));
    if (!title) continue;

    const dateText = text(card.querySelector('.date small') || card.querySelector('.date'));
    const parsedDate = parseGeneveDateFr(dateText, now);
    if (!parsedDate) {
      skippedNoDate += 1;
      continue;
    }

    const paragraphs = [...card.querySelectorAll('.boite__contenu p, p')];
    const tagParagraphs = paragraphs.filter((p) => p.classList.contains('tags'));
    const descriptionEl = paragraphs.find((p) => !p.classList.contains('tags'));
    const description = text(descriptionEl);
    const tags = tagParagraphs.map((p) => text(p)).filter(Boolean);
    const category = tags.length ? tags[tags.length - 1] : undefined;

    const img = card.querySelector('.evenements-lies--img img, img');
    const rawImageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || '';

    const { comune, method } = resolveComune({ venue: description, title, region: 'Genève' }, comuni);

    events.push({
      id: eventStableId(SOURCE.key, rawId),
      title,
      startDate: parsedDate.startDate,
      endDate: parsedDate.endDate !== parsedDate.startDate ? parsedDate.endDate : undefined,
      category: category || undefined,
      region: 'Genève',
      description: description || undefined,
      comune: comune || undefined,
      comuneMatch: method || undefined,
      canton: SOURCE.canton,
      url: absoluteUrl(href),
      imageUrl: absoluteUrl(rawImageUrl) || undefined,
    });
  }

  if (skippedNoDate > 0) {
    console.warn(`[ge-agenda] page ${page}: skipped ${skippedNoDate} card(s) with an unparseable date`);
  }
  return events;
}

const crawler = createAgendaCrawler({
  sourceKey: SOURCE.key,
  baseUrl: PAGE_URL,
  parseDayHtml: parseGeneveAgendaHtml,
  iterations: MAX_PAGES,
  horizonDays: HORIZON_DAYS,
  stopOnEmptyPage: true,
});

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const { events } = await crawler.crawl({ dryRun });
  if (dryRun) {
    console.log(JSON.stringify(events.slice(0, 3), null, 2));
  }
}

// Only crawl when invoked directly (`node scripts/crawl-ge-agenda.mjs`), so
// tests can import `parseGeneveAgendaHtml`/`parseGeneveDateFr` without
// triggering a live fetch.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[ge-agenda] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
