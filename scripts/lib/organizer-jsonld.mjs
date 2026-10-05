/**
 * scripts/lib/organizer-jsonld.mjs
 *
 * Reading the schema.org Event JSON-LD that an event ORGANIZER publishes on
 * its own pages (first user: classicAscona, owner decision D3 of 2026-10-05).
 *
 * «Solo fatti»: this module returns facts only — name, start, venue, address,
 * performer names, organizer name and the structured offer. It never returns
 * the organizer's `description` or `image`: those are the organizer's
 * content, and with no licence we do not republish them.
 *
 * Prices (rule H5, D4): only the structured offer of the JSON-LD, stamped with
 * its provenance so `hasConfidentPrice()` can admit it per source:
 *   - `AggregateOffer.lowPrice` → `priceField: 'offers.lowPrice'` («from CHF X»),
 *     with `highPrice` kept when it is a valid upper bound;
 *   - `Offer.price`             → `priceField: 'offers.price'` (single price).
 * A zero, blank or missing amount never becomes «free»: an Offer without a
 * price (the free «Next Generation» concerts) gives no price, and `price: 0`
 * without `isAccessibleForFree` is the placeholder trap seen on inCittà.
 * The structured amounts must also appear among the tariffs the page shows to
 * its visitors; when they do not, the price is discarded with a reason.
 */
import { cleanEventText } from './events-utils.mjs';
import { extractEventOfferMetadata, eventOfferPriceAmount } from './event-metadata.mjs';
import { parseJsonLdText } from './json-ld-text.mjs';

const JSON_LD_SCRIPT_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Parse one JSON-LD block with the shared tolerant parser (raw line breaks
 * inside strings, BOM, comment wrapper: scripts/lib/json-ld-text.mjs).
 * Returns undefined when the block is not JSON even after that repair.
 */
export function parseJsonLdBlock(raw) {
  if (!String(raw ?? '').trim()) return undefined;
  try {
    return parseJsonLdText(raw);
  } catch {
    return undefined;
  }
}

function flattenNodes(value, out) {
  if (Array.isArray(value)) {
    for (const entry of value) flattenNodes(entry, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  out.push(value);
  if (Array.isArray(value['@graph'])) flattenNodes(value['@graph'], out);
  return out;
}

/** Every JSON-LD node of a page, `@graph` members included. */
export function extractJsonLdNodes(html) {
  const nodes = [];
  for (const match of String(html ?? '').matchAll(JSON_LD_SCRIPT_RE)) {
    const parsed = parseJsonLdBlock(match[1]);
    if (parsed !== undefined) flattenNodes(parsed, nodes);
  }
  return nodes;
}

function schemaTypeName(value) {
  const type = value.trim().replace(/[\/#]+$/, '');
  return type.slice(Math.max(type.lastIndexOf('/'), type.lastIndexOf('#')) + 1);
}

function typesOf(node) {
  const value = node?.['@type'];
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => typeof entry === 'string')
    .map(schemaTypeName)
    .filter(Boolean);
}

/** schema.org Event and its subtypes (MusicEvent, TheaterEvent, …). */
export function isEventNode(node) {
  return typesOf(node).some((type) => /^(?:[A-Z][A-Za-z]*)?Event$/.test(type) && type !== 'EventSeries');
}

/** The Event nodes of a page. */
export function extractEventNodes(html) {
  return extractJsonLdNodes(html).filter(isEventNode);
}

const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

/**
 * `2026-10-07T19:30:00+02:00` → `{ day: '2026-10-07', time: '19:30' }`, read
 * in the offset the organizer wrote (local Swiss time), never shifted through
 * UTC. Returns undefined for an invalid calendar day or clock time.
 */
export function parseLocalDateTime(raw) {
  const match = ISO_LOCAL_RE.exec(String(raw ?? '').trim());
  if (!match) return undefined;
  const [, y, m, d, hh, mm] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return undefined;
  }
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return undefined;
  return { day: `${y}-${m}-${d}`, ...(hh !== undefined ? { time: `${hh}:${mm}` } : {}) };
}

/** Plain text of a JSON-LD string: entities decoded (`&#038;` → `&`), tags stripped. */
export function ldText(value) {
  return typeof value === 'string' ? cleanEventText(value) : '';
}

/** Names only (no URL, image or bio) of a performer/organizer value. */
export function ldPersonNames(value) {
  const entries = Array.isArray(value) ? value : [value];
  const names = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? ldText(entry) : ldText(entry?.name);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Venue and postal address of a JSON-LD `location`. A trailing country in the
 * locality («Locarno, Svizzera») is dropped: the country is a separate field.
 */
export function ldLocation(location) {
  const place = Array.isArray(location) ? location.find((entry) => entry && typeof entry === 'object') : location;
  if (!place || typeof place !== 'object') return {};
  const venue = ldText(place.name);
  const address = place.address && typeof place.address === 'object' ? place.address : {};
  const street = ldText(address.streetAddress);
  const postalCode = ldText(address.postalCode);
  const locality = ldText(address.addressLocality)
    .replace(/,\s*(?:svizzera|schweiz|suisse|switzerland|ch)\s*$/i, '')
    .trim();
  const country = ldText(address.addressCountry).toUpperCase();
  return {
    ...(venue ? { venue } : {}),
    address: {
      ...(street ? { street } : {}),
      ...(/^\d{4}$/.test(postalCode) ? { postalCode } : {}),
      ...(locality ? { locality } : {}),
    },
    ...(country ? { country } : {}),
  };
}

function offerEntries(value) {
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry && typeof entry === 'object');
}

function amountsAreShown(amounts, shownTariffs) {
  return amounts.every((amount) => shownTariffs.some((shown) => Math.abs(shown - amount) < 0.005));
}

/**
 * Structured price of an organizer Event node, or `{ rejected }` with the
 * reason it was discarded, or undefined when the node carries no amount.
 *
 * @param {object} ld - the Event JSON-LD node.
 * @param {object} options
 * @param {string} options.priceSource - the admitted source key (EVENT_PRICE_FIELD_RULES).
 * @param {number[] | undefined} options.shownTariffs - amounts the page shows to
 *   visitors; when given, every structured amount must be among them.
 * @param {string} [options.baseUrl] - for relative offer URLs.
 * @returns {{ price?: object, rejected?: string } | undefined}
 */
export function extractOrganizerOfferPrice(ld, { priceSource, shownTariffs, baseUrl } = {}) {
  const offers = offerEntries(ld?.offers);
  if (!offers.length) return undefined;
  const candidates = [];
  for (const offer of offers) {
    const currency = typeof offer.priceCurrency === 'string' ? offer.priceCurrency.trim().toUpperCase() : '';
    const isAggregate = typesOf(offer).includes('AggregateOffer');
    const low = eventOfferPriceAmount(isAggregate ? offer.lowPrice : offer.price);
    if (!Number.isFinite(low)) continue;
    if (low <= 0) {
      // Zero is a price claim only with isAccessibleForFree, which this
      // family of sources is not admitted to assert: never «free».
      candidates.push({ rejected: `${isAggregate ? 'lowPrice' : 'price'} ${low} is not a tariff` });
      continue;
    }
    if (!currency) {
      candidates.push({ rejected: 'offer without priceCurrency' });
      continue;
    }
    const high = isAggregate ? eventOfferPriceAmount(offer.highPrice) : NaN;
    const highPrice = Number.isFinite(high) && high >= low ? high : undefined;
    candidates.push({
      offer,
      price: {
        amount: low,
        ...(highPrice !== undefined && highPrice !== low ? { highPrice } : {}),
        currency,
        isFree: false,
        ...(extractEventOfferMetadata(offer, baseUrl) || {}),
        priceSource,
        priceField: isAggregate ? 'offers.lowPrice' : 'offers.price',
      },
    });
  }
  const priced = candidates.filter((candidate) => candidate.price);
  if (!priced.length) return candidates.length ? { rejected: candidates[0].rejected } : undefined;
  const cheapest = priced.reduce((best, candidate) => (candidate.price.amount < best.price.amount ? candidate : best));
  if (Array.isArray(shownTariffs)) {
    const amounts = [cheapest.price.amount, ...(cheapest.price.highPrice !== undefined ? [cheapest.price.highPrice] : [])];
    if (!amountsAreShown(amounts, shownTariffs)) {
      return { rejected: `structured ${amounts.join('/')} not among the shown tariffs ${shownTariffs.join('/') || '(none)'}` };
    }
  }
  return { price: cheapest.price };
}
