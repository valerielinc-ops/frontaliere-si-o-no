import { JSDOM } from 'jsdom';
import { eventOfferPriceAmount, extractEventOfferMetadata, parseEventPriceText } from './event-metadata.mjs';

const BOOKING_HOSTS = new Set(['infomaniak.events', 'tickets.club-bellevue.ch', 'ticketing-nodabcvs.mapado.com']);
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export function supportedEventBookingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && BOOKING_HOSTS.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sameVenue(left, right) {
  const normalize = value => typeof value === 'string'
    ? value.split(/\s+[-–—]\s+/)[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
  const a = normalize(left);
  const b = normalize(right);
  return a.length >= 4 && b.length >= 4 && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
}

function localDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(date) : undefined;
}

function eventNodes(doc) {
  const nodes = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().some(type => typeof type === 'string' && /event$/i.test(type))) nodes.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Ignore malformed blocks. */ }
  }
  return nodes;
}

function cheapest(prices) {
  const known = prices.filter(price => Number.isFinite(price?.amount) && price.amount >= 0);
  if (!known.length || new Set(known.map(price => price.currency)).size !== 1) return undefined;
  return known.reduce((best, price) => price.amount < best.amount ? price : best);
}

/** Follow an explicit source booking link only when its date and venue identify the same event. */
export function extractEventBookingPrice(html, bookingUrl, event) {
  const supported = supportedEventBookingUrl(bookingUrl);
  if (!supported || typeof html !== 'string' || !event?.startDate || !event.venue) return undefined;
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    const host = new URL(supported).hostname;
    const matching = eventNodes(doc).filter(node => localDate(node.startDate) === event.startDate
      && sameVenue(node.location?.name, event.venue));
    if (host === 'ticketing-nodabcvs.mapado.com') {
      // Mapado renders tariffs in HTML, but adds JSON-LD only after hydration.
      const spans = [...(doc.querySelector('main .mpd-card')?.children || [])].map(node => node.textContent.trim());
      const month = spans[2]?.match(/^([\p{L}.]+)\s+(\d{4})$/u);
      const months = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
      const monthIndex = month ? months.indexOf(month[1].toLowerCase()) : -1;
      const date = monthIndex >= 0 && /^\d{1,2}$/.test(spans[1])
        ? `${month[2]}-${String(monthIndex + 1).padStart(2, '0')}-${spans[1].padStart(2, '0')}` : undefined;
      const venue = doc.querySelector('main h1 + p')?.textContent;
      if (date !== event.startDate || !sameVenue(venue, event.venue)) return undefined;
      const prices = [...doc.querySelectorAll('main .mpd-card')]
        .filter(card => card.querySelector('button[aria-label="Ajouter"]'))
        .map(card => {
          const label = card.firstElementChild?.textContent || '';
          const price = parseEventPriceText(card.querySelector('.h2-like')?.textContent);
          // A free child/member tariff does not establish free general admission.
          return price?.isFree && /\b(?:enfants?|kinder|children|membres?|members?)\b/i.test(label) ? undefined : price;
        });
      const price = cheapest(prices);
      return price ? { ...price, url: supported } : undefined;
    }
    // A related event with another date or venue must never donate its price.
    if (matching.length !== 1) return undefined;
    const node = matching[0];
    if (host === 'tickets.club-bellevue.ch') {
      // JSON-LD advertises the base price. The visible admission row includes
      // mandatory fees; lounge packages and drink vouchers are other products.
      const prices = [...doc.querySelectorAll('#shopitems tr')]
        .filter(row => /^Normales Ticket$/i.test(row.querySelector('.shopitem-title')?.textContent.trim() || ''))
        .map(row => parseEventPriceText(row.querySelector('.shop-cart-price > div:first-child')?.textContent));
      const price = cheapest(prices);
      return price ? { ...extractEventOfferMetadata(node.offers, supported), ...price, url: supported } : undefined;
    }
    const offers = [node.offers].flat().filter(offer => offer && typeof offer === 'object');
    const prices = offers.map(offer => {
      const amount = eventOfferPriceAmount(offer.price ?? offer.lowPrice);
      const currency = offer.priceCurrency;
      if (!Number.isFinite(amount) || amount < 0 || !/^(?:CHF|EUR)$/.test(currency || '')) return undefined;
      return { ...extractEventOfferMetadata(offer, supported), amount, currency, isFree: amount === 0, url: supported };
    });
    return cheapest(prices);
  } finally {
    dom.window.close();
  }
}

/** Bounded, public, allowlisted reads; failed or unrelated pages leave the price unknown. */
export async function fetchEventBookingPrice(event, bookingUrl, { fetchImpl = fetch } = {}) {
  let url = supportedEventBookingUrl(bookingUrl);
  if (!url) return undefined;
  const origin = new URL(url).origin;
  const signal = AbortSignal.timeout(20000);
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const res = await fetchImpl(url, { signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) return undefined;
        const next = supportedEventBookingUrl(new URL(location, url).href);
        if (!next || new URL(next).origin !== origin) return undefined;
        url = next;
        continue;
      }
      if (!res.ok || !res.body) { await res.body?.cancel(); return undefined; }
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_HTML_BYTES) { await reader.cancel(); return undefined; }
        chunks.push(Buffer.from(value));
      }
      return extractEventBookingPrice(Buffer.concat(chunks).toString('utf8'), url, event);
    }
  } catch { /* Best-effort enrichment; never fabricate a tariff on failure. */ }
  return undefined;
}
