/**
 * Eventfrog Public API v1 client and record mapper (Passo 2 of the events
 * source plan, owner decision D5 of 2026-10-05).
 *
 * Spec: https://docs.api.eventfrog.net/openapi/publicapi-v1/bundle.yaml
 * Terms: https://eventfrog.ch/de/agb.html (v1.28), §17.
 *
 * What the terms impose on this module, and how:
 *   - Limits: 30 requests per minute and 2,000 per day per account. Requests
 *     are serialised with MIN_REQUEST_GAP_MS between them and a run never
 *     makes more than MAX_REQUESTS_PER_RUN; Ticino needs a handful.
 *   - Authentication: `Authorization: Bearer <key>` only (the query-string key
 *     is deprecated). The key is never logged or put in an error message.
 *   - §17(5) no content change: titles are kept exactly as Eventfrog returns
 *     them, per language, with no translation. Descriptions
 *     (`shortDescription`, `descriptionAsHTML`) are NOT stored at all: our
 *     page describes the event from facts only (date, place, price,
 *     organizer), in our own words.
 *   - Spec "no hotlinking": image URLs are not stored; the page uses the
 *     site's own category illustration.
 *   - Cancelled, hidden or unpublished events are not kept: a page would
 *     otherwise announce an event that will not take place.
 */

import { cantonAtPoint } from './swiss-canton-geo.mjs';
import { resolveComuneNationwide } from './events-utils.mjs';

export const EVENTFROG_API_BASE = 'https://api.eventfrog.net';
export const EVENTFROG_SOURCE_KEY = 'eventfrog';
export const EVENTFROG_SOURCE_NAME = 'Eventfrog';

/** Bellinzona, centre of the Ticino search circle (P20 of the source report). */
export const TICINO_SEARCH_CENTER = Object.freeze({ lat: 46.1946, lng: 9.0244 });
/** Radius in km; the canton filter below drops the Grisons/Lombardy/Uri spill. */
export const TICINO_SEARCH_RADIUS_KM = 50;

/** 60 s / 30 requests = 2 s; the extra margin absorbs clock jitter. */
export const MIN_REQUEST_GAP_MS = 2100;
/** Hard cap per run, far below the 2,000/day account quota. */
export const MAX_REQUESTS_PER_RUN = 60;
export const PER_PAGE = 1000;
const LOCATION_BATCH = 100;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 30_000;

const SITE_LOCALES = ['it', 'en', 'de', 'fr'];
/** Language preference for the single `title`/`venue` string (Ticino first). */
const PRIMARY_LANGUAGE_ORDER = ['it', 'de', 'fr', 'en'];

/**
 * A request budget + pacing gate shared by every call of one run.
 *
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, maxRequests?: number, gapMs?: number }} [opts]
 */
export function createRequestPacer(opts = {}) {
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now || (() => Date.now());
  const maxRequests = opts.maxRequests ?? MAX_REQUESTS_PER_RUN;
  const gapMs = opts.gapMs ?? MIN_REQUEST_GAP_MS;
  let last = -Infinity;
  let count = 0;
  return {
    get count() {
      return count;
    },
    async take() {
      if (count >= maxRequests) {
        throw new Error(`Eventfrog request budget exhausted (${maxRequests} per run)`);
      }
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      count += 1;
    },
    sleep,
  };
}

/**
 * One authenticated GET against the Public API. Returns parsed JSON or throws
 * an error whose message carries only the path and the status.
 *
 * @param {string} pathWithQuery e.g. `/public/v1/events?lat=…`
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, pacer: ReturnType<typeof createRequestPacer> }} ctx
 */
export async function eventfrogGet(pathWithQuery, ctx) {
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const routeOnly = pathWithQuery.split('?')[0];
  for (let attempt = 0; ; attempt += 1) {
    await ctx.pacer.take();
    let res;
    try {
      res = await fetchImpl(`${EVENTFROG_API_BASE}${pathWithQuery}`, {
        headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await ctx.pacer.sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw new Error(`Eventfrog ${routeOnly}: network error (${error?.name || 'Error'})`);
    }
    if (res.ok) return res.json();
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      await ctx.pacer.sleep(RETRY_BACKOFF_MS);
      continue;
    }
    throw new Error(`Eventfrog ${routeOnly}: HTTP ${res.status}`);
  }
}

/** `YYYY-MM-DD` of today in Europe/Zurich. */
export function zurichToday(date = new Date()) {
  return zurichParts(date.toISOString())?.date ?? date.toISOString().slice(0, 10);
}

/**
 * Every event of the search circle that starts today or later, all pages.
 * Throws when the pages do not add up to the declared total: a partial list
 * must never replace a complete snapshot (it would drop live pages), and an
 * unreadable answer must never be taken as "no events".
 */
export async function fetchEventsInCircle(ctx, { center = TICINO_SEARCH_CENTER, radiusKm = TICINO_SEARCH_RADIUS_KM, fromDate = zurichToday() } = {}) {
  const events = [];
  let total = null;
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      lat: String(center.lat),
      lng: String(center.lng),
      r: String(radiusKm),
      from: fromDate,
      perPage: String(PER_PAGE),
      page: String(page),
    });
    const body = await eventfrogGet(`/public/v1/events?${query}`, ctx);
    if (!body || !Array.isArray(body.events) || !Number.isInteger(body.totalNumberOfResources)) {
      throw new Error('Eventfrog /public/v1/events: unexpected response shape');
    }
    total = body.totalNumberOfResources;
    events.push(...body.events);
    if (events.length >= total || body.events.length === 0) break;
  }
  if (events.length < total) {
    throw new Error(`Eventfrog /public/v1/events: incomplete listing (${events.length} of ${total})`);
  }
  return { events, total };
}

/** Locations by id, in batches of 100 (`id=…&id=…`). */
export async function fetchLocations(ids, ctx) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const byId = new Map();
  for (let i = 0; i < unique.length; i += LOCATION_BATCH) {
    const batch = unique.slice(i, i + LOCATION_BATCH);
    const query = new URLSearchParams();
    for (const id of batch) query.append('id', id);
    query.set('perPage', String(LOCATION_BATCH));
    const body = await eventfrogGet(`/public/v1/locations?${query}`, ctx);
    if (!body || !Array.isArray(body.locations)) {
      throw new Error('Eventfrog /public/v1/locations: unexpected response shape');
    }
    for (const location of body.locations) {
      if (location && typeof location.id === 'string') byId.set(location.id, location);
    }
  }
  return byId;
}

/** Date and HH:MM in Europe/Zurich of an ISO date-time, or null. */
export function zurichParts(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Non-empty strings of a multilingual map, untouched. */
function languageMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.trim()) out[lang] = text;
  }
  return out;
}

function primaryText(map) {
  for (const lang of PRIMARY_LANGUAGE_ORDER) if (map[lang]) return map[lang];
  const first = Object.values(map)[0];
  return typeof first === 'string' ? first : '';
}

/**
 * The structured price of an event, only when every condition holds
 * (source report §5, Passo 2): the venue is in Switzerland (the field carries
 * no currency, so CHF is inferred from `location.country`), the event sells
 * tickets (`agendaEntryOnly === false`), it is not cancelled, and the amount
 * is a positive number. Whether the price is SHOWN is decided by the H5
 * registry (`hasConfidentPrice` in scripts/lib/events-utils.mjs), not here.
 */
export function eventfrogPrice(event, location) {
  const amount = event?.lowestTicketPrice;
  if (location?.country !== 'CH') return undefined;
  if (event?.agendaEntryOnly !== false) return undefined;
  if (event?.cancelled !== false) return undefined;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
  return {
    amount,
    currency: 'CHF',
    isFree: false,
    priceSource: EVENTFROG_SOURCE_KEY,
    priceField: 'lowestTicketPrice',
    currencySource: 'location.country',
  };
}

function httpsUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map one API event (+ its first location) to the private snapshot record, or
 * return `{ skip: <reason> }`. Reasons are counted, never logged per event.
 *
 * @param {Record<string, any>} event
 * @param {Map<string, Record<string, any>>} locationsById
 * @param {{ cantonAt?: (geo: {lat:number,lng:number}) => string|null, canton?: string }} [opts]
 */
export function mapEventfrogEvent(event, locationsById, opts = {}) {
  const cantonAt = opts.cantonAt || cantonAtPoint;
  const wantedCanton = opts.canton || 'TI';
  if (!event || typeof event.id !== 'string' || !event.id) return { skip: 'invalid' };
  if (event.cancelled !== false) return { skip: 'cancelled' };
  if (event.visible === false || event.published === false) return { skip: 'hidden' };
  const titles = languageMap(event.title);
  const title = primaryText(titles);
  if (!title) return { skip: 'invalid' };
  const begin = zurichParts(event.begin);
  if (!begin) return { skip: 'invalid' };
  const end = zurichParts(event.end);
  const location = (Array.isArray(event.locationIds) ? event.locationIds : [])
    .map((id) => locationsById.get(id))
    .find(Boolean);
  if (!location) return { skip: 'no-location' };
  const geo = Number.isFinite(location.lat) && Number.isFinite(location.lng) ? { lat: location.lat, lng: location.lng } : null;
  if (!geo) return { skip: 'no-coordinates' };
  if (cantonAt(geo) !== wantedCanton) return { skip: 'outside-canton' };
  const url = httpsUrl(event.url);
  if (!url) return { skip: 'invalid' };

  const titleByLocale = {};
  for (const locale of SITE_LOCALES) if (titles[locale]) titleByLocale[locale] = titles[locale];
  const venue = primaryText(languageMap(event.locationAlias)) || primaryText(languageMap(location.title)) || undefined;
  const city = typeof location.city === 'string' && location.city.trim() ? location.city.trim() : undefined;
  // The city first: it is the field Eventfrog fills with the municipality,
  // while the venue name only occasionally contains it.
  const resolved = resolveComuneNationwide({ venue: [city, venue].filter(Boolean).join(' '), title: '' }, wantedCanton);
  const address = {
    ...(typeof location.addressLine === 'string' && location.addressLine.trim() ? { street: location.addressLine.trim() } : {}),
    ...(typeof location.zip === 'string' && location.zip.trim() ? { postalCode: location.zip.trim() } : {}),
    ...(city ? { locality: city } : {}),
  };
  const price = eventfrogPrice(event, location);
  const organizerName = typeof event.organizerName === 'string' && event.organizerName.trim() ? event.organizerName.trim() : undefined;
  const presaleLink = httpsUrl(event.presaleLink);

  return {
    record: {
      id: `${EVENTFROG_SOURCE_KEY}:${event.id}`,
      sourceKey: EVENTFROG_SOURCE_KEY,
      sourceName: EVENTFROG_SOURCE_NAME,
      ephemeral: true,
      title,
      ...(Object.keys(titleByLocale).length ? { titleByLocale } : {}),
      startDate: begin.date,
      ...(event.begin && /T\d{2}:\d{2}/.test(event.begin) ? { startTime: begin.time } : {}),
      ...(end && end.date > begin.date ? { endDate: end.date } : {}),
      ...(venue ? { venue } : {}),
      comune: resolved.canton === wantedCanton && resolved.comune ? resolved.comune : undefined,
      canton: wantedCanton,
      ...(Object.keys(address).length ? { address } : {}),
      geo,
      ...(organizerName ? { organizer: { '@type': 'Organization', name: organizerName } } : {}),
      url,
      ...(presaleLink ? { presaleLink } : {}),
      ...(price ? { price } : {}),
      ...(event.soldOut === true ? { soldOut: true } : {}),
      ...(typeof event.modifyDate === 'string' ? { sourceModifiedAt: event.modifyDate } : {}),
    },
  };
}

/**
 * Fetch and map the Ticino events. Returns the records plus counts only.
 *
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, pacer?: ReturnType<typeof createRequestPacer>, fromDate?: string, cantonAt?: Function }} opts
 */
export async function fetchTicinoEventfrogRecords(opts) {
  if (!opts?.apiKey) throw new Error('EVENTFROG_PUBLIC_API_KEY is required');
  const pacer = opts.pacer || createRequestPacer();
  const ctx = { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, pacer };
  const { events, total } = await fetchEventsInCircle(ctx, { fromDate: opts.fromDate || zurichToday() });
  const locationIds = events.flatMap((event) => (Array.isArray(event?.locationIds) ? event.locationIds : []));
  const locations = await fetchLocations(locationIds, ctx);
  const skipped = {};
  const byId = new Map();
  for (const event of events) {
    const mapped = mapEventfrogEvent(event, locations, { cantonAt: opts.cantonAt });
    if (mapped.skip) {
      skipped[mapped.skip] = (skipped[mapped.skip] || 0) + 1;
      continue;
    }
    byId.set(mapped.record.id, mapped.record);
  }
  const records = [...byId.values()].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id),
  );
  return {
    records,
    counts: {
      apiTotal: total,
      fetched: events.length,
      kept: records.length,
      withPrice: records.filter((record) => record.price).length,
      requests: pacer.count,
      skipped,
    },
  };
}
