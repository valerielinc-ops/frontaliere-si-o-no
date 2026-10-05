/**
 * Tariffe eventi: un prezzo mostrato come affidabile senza una fonte strutturata.
 *
 * Owner decision 2026-10-04 (FU-2026-10-03-002): event tariffs come from
 * MySwitzerland (primary) and Guidle (secondary), the source travels with the
 * value (`priceSource` + `priceField`), and a price is reliable — published as
 * schema.org `offers`/`isAccessibleForFree` or in the visible price line —
 * only when it was read from a structured field (JSON-LD `offers[].price`,
 * `isAccessibleForFree`). Tariff text (MySwitzerland detail table, Guidle
 * accordion, indexed copy, third-party ticketing pages, tio.ch labels) stays
 * in the data but is never reliable.
 *
 * Fixtures under tests/fixtures/event-price-sources/ are real, PII-free
 * source shapes: a live Guidle page (no JSON-LD Offer, tariff only in the
 * accordion), a MySwitzerland JSON-LD Offer reconstructed from its published
 * record, and a MySwitzerland detail table with real tariff text.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVENT_PRICE_FIELD_RULES,
  EVENT_PRICE_SOURCES,
  STRUCTURED_EVENT_PRICE_FIELDS,
  eventfrogLowestTicketPrice,
  hasConfidentPrice,
  hasParsedPrice,
  isFromEventPrice,
  openAgendaGratuitPrice,
} from '../scripts/lib/events-utils.mjs';
import {
  applyKnownPriceBackfills,
  extractEventJsonLd,
  extractPrice as extractMySwitzerlandPrice,
} from '../scripts/crawl-myswitzerland-events.mjs';
import { mapDetailPageToLocaleData } from '../scripts/crawl-guidle-events.mjs';
import { pickRichestEvent } from '../scripts/assemble-events-dataset.mjs';
import { eventLd, renderEventDetailPage } from '../build-plugins/eventsSeoPagesPlugin';
import { slugifyEvent } from '../scripts/lib/events-utils.mjs';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/event-price-sources/${name}`, import.meta.url), 'utf8');

const MYSWITZERLAND_URL = 'https://www.myswitzerland.com/en-ch/experiences/events/96th-international-ice-hockey-tournament-for-the-spengler-cup/';
const GUIDLE_URL = 'https://www.guidle.com/it/eventi/winterthur/26-festival-internazionale-del-cortometraggio-di-winterthur_AJdd68h';

function mySwitzerlandPrice(name: string) {
  const html = fixture(name);
  return extractMySwitzerlandPrice(extractEventJsonLd(html), html, MYSWITZERLAND_URL);
}

const BASE_EVENT = {
  id: 'tio-agenda:7001',
  title: 'Torneo di hockey',
  startDate: '2026-12-26',
  endDate: '2026-12-31',
  category: 'sport',
  venue: 'zondacrypto-Arena',
  comune: 'Davos',
  canton: 'GR',
  url: 'https://www.tio.ch/agenda/day/20261226/7001',
  sourceKey: 'tio-agenda',
  sourceName: 'Tio.ch Agenda',
};

function publishedPrice(price: Record<string, unknown> | undefined) {
  const ld = eventLd({ ...BASE_EVENT, price } as never, 'it') as Record<string, any>;
  const page = renderEventDetailPage({
    locale: 'it',
    event: { ...BASE_EVENT, price } as never,
    comune: 'Davos',
    eventSlug: slugifyEvent(BASE_EVENT),
    sameComuneEvents: [{ ...BASE_EVENT, price }] as never,
    dateStamp: '2026-10-04',
    distDir: mkdtempSync(path.join(os.tmpdir(), 'event-price-sources-')),
    detailHref: (() => null) as never,
  });
  return { offers: ld.offers, isAccessibleForFree: ld.isAccessibleForFree, priceLine: /Prezzo/.test(page.html) };
}

/** The visible price metric value of the detail page in `locale`, or undefined. */
function visiblePrice(price: Record<string, unknown> | undefined, locale: 'it' | 'en' | 'de' | 'fr' = 'it') {
  const page = renderEventDetailPage({
    locale,
    event: { ...BASE_EVENT, price } as never,
    comune: 'Davos',
    eventSlug: slugifyEvent(BASE_EVENT),
    sameComuneEvents: [{ ...BASE_EVENT, price }] as never,
    dateStamp: '2026-10-04',
    distDir: mkdtempSync(path.join(os.tmpdir(), 'event-price-sources-')),
    detailHref: (() => null) as never,
  });
  const label = { it: 'Prezzo', en: 'Price', de: 'Preis', fr: 'Prix' }[locale];
  return new RegExp(`<dt class="ev-metric-t">${label}</dt>\\s*<dd class="ev-metric-v">([^<]*)</dd>`).exec(page.html)?.[1];
}

describe('Tariffe eventi: un prezzo mostrato come affidabile senza una fonte strutturata', () => {
  it('admits exactly the owner-approved (source, field) pairs, in precedence order (2026-10-04 + D4 2026-10-05)', () => {
    expect(EVENT_PRICE_SOURCES).toEqual(['myswitzerland', 'guidle', 'classicascona', 'eventfrog', 'openagenda']);
    expect(Object.fromEntries(Object.entries(EVENT_PRICE_FIELD_RULES).map(([source, fields]) => [source, Object.keys(fields)]))).toEqual({
      myswitzerland: ['offers.price', 'isAccessibleForFree'],
      guidle: ['offers.price', 'isAccessibleForFree'],
      classicascona: ['offers.price', 'offers.lowPrice'],
      eventfrog: ['lowestTicketPrice'],
      openagenda: ['gratuit'],
    });
    expect(STRUCTURED_EVENT_PRICE_FIELDS).toEqual(['offers.price', 'isAccessibleForFree', 'offers.lowPrice', 'lowestTicketPrice', 'gratuit']);
    expect(Object.isFrozen(EVENT_PRICE_FIELD_RULES.eventfrog.lowestTicketPrice)).toBe(true);
  });

  it.each([
    ['an Eventfrog record with a JSON-LD field', { amount: 20, currency: 'CHF', isFree: false, priceSource: 'eventfrog', priceField: 'offers.price' }],
    ['a classicAscona record asserting free admission', { amount: 0, currency: 'CHF', isFree: true, priceSource: 'classicascona', priceField: 'offers.price' }],
    ['a classicAscona record with an OpenAgenda field', { amount: 0, currency: 'CHF', isFree: true, priceSource: 'classicascona', priceField: 'gratuit' }],
    ['an OpenAgenda «gratuit» carrying an amount', { amount: 15, currency: 'CHF', isFree: false, priceSource: 'openagenda', priceField: 'gratuit' }],
    ['OpenAgenda conditions (free text)', { amount: 10, currency: 'CHF', isFree: false, priceSource: 'openagenda', priceField: 'conditions' }],
    ['an Eventfrog amount without the country-derived currency', { amount: 30, currency: 'CHF', isFree: false, priceSource: 'eventfrog', priceField: 'lowestTicketPrice' }],
    ['an Eventfrog amount in EUR', { amount: 30, currency: 'EUR', isFree: false, priceSource: 'eventfrog', priceField: 'lowestTicketPrice', currencySource: 'location.country' }],
    ['an Eventfrog zero', { amount: 0, currency: 'CHF', isFree: true, priceSource: 'eventfrog', priceField: 'lowestTicketPrice', currencySource: 'location.country' }],
    ['a classicAscona lowPrice of zero', { amount: 0, currency: 'CHF', isFree: false, priceSource: 'classicascona', priceField: 'offers.lowPrice' }],
  ])('%s → not admitted by the per-source registry', (_label, price) => {
    expect(hasConfidentPrice(price)).toBe(false);
    expect(publishedPrice(price)).toEqual({ offers: undefined, isAccessibleForFree: undefined, priceLine: false });
  });

  it('structured MySwitzerland field → reliable, published as an Offer', () => {
    const price = mySwitzerlandPrice('myswitzerland-offer.html');
    expect(price).toMatchObject({
      amount: 35, currency: 'CHF', isFree: false,
      priceSource: 'myswitzerland', priceField: 'offers.price',
      url: 'https://www.spenglercup.ch/de/besuch/tickets',
    });
    expect(hasConfidentPrice(price)).toBe(true);
    const published = publishedPrice(price);
    expect(published.offers).toMatchObject({ '@type': 'Offer', price: 35, priceCurrency: 'CHF' });
    expect(published.priceLine).toBe(true);
  });

  it('text only (MySwitzerland detail table) → recorded with its field, not reliable, not published', () => {
    const price = mySwitzerlandPrice('myswitzerland-detail-table.html');
    expect(price).toMatchObject({ amount: 5.3, priceSource: 'myswitzerland', priceField: 'detail-table' });
    expect(hasParsedPrice(price)).toBe(true);
    expect(hasConfidentPrice(price)).toBe(false);
    expect(publishedPrice(price)).toEqual({ offers: undefined, isAccessibleForFree: undefined, priceLine: false });
  });

  it('text only (Guidle accordion, no JSON-LD Offer on the live page) → not reliable, not published', () => {
    const mapped = mapDetailPageToLocaleData(fixture('guidle-price-accordion.html'), 'it', GUIDLE_URL);
    expect(mapped?.price).toMatchObject({ amount: 18, priceSource: 'guidle', priceField: 'price-accordion' });
    expect(hasConfidentPrice(mapped?.price)).toBe(false);
    expect(publishedPrice(mapped?.price).offers).toBeUndefined();
  });

  it('structured Guidle field wins over its own accordion text', () => {
    const html = fixture('guidle-price-accordion.html').replace(
      '"location":',
      '"offers":{"@type":"Offer","price":"18","priceCurrency":"CHF"},"location":',
    );
    const mapped = mapDetailPageToLocaleData(html, 'it', GUIDLE_URL);
    expect(mapped?.price).toMatchObject({ amount: 18, priceSource: 'guidle', priceField: 'offers.price' });
    expect(hasConfidentPrice(mapped?.price)).toBe(true);
  });

  it.each([
    ['legacy record without provenance', { amount: 20, currency: 'CHF', isFree: false }],
    ['free admission read from text', { amount: 0, currency: 'CHF', isFree: true, priceSource: 'guidle', priceField: 'price-accordion' }],
    ['unknown source with a structured field', { amount: 20, currency: 'CHF', isFree: false, priceSource: 'tio-agenda', priceField: 'offers.price' }],
    ['third-party ticketing page', { amount: 20, currency: 'CHF', isFree: false, priceSource: 'myswitzerland', priceField: 'booking-page' }],
  ])('%s → never published (no Offer, no isAccessibleForFree, no price line)', (_label, price) => {
    expect(hasConfidentPrice(price)).toBe(false);
    expect(publishedPrice(price)).toEqual({ offers: undefined, isAccessibleForFree: undefined, priceLine: false });
  });

  it('conflict between sources → MySwitzerland wins and the conflict is recorded on the price', () => {
    const mySwitzerland = {
      ...BASE_EVENT, id: 'myswitzerland:spengler', sourceKey: 'myswitzerland',
      price: mySwitzerlandPrice('myswitzerland-offer.html'),
    };
    // No live Guidle page carried an Offer price (3 of 3 checked on 2026-10-04):
    // this structured Guidle value is constructed to exercise the precedence.
    const guidle = {
      ...BASE_EVENT, id: 'guidle:spengler', sourceKey: 'guidle',
      price: { amount: 30, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'offers.price' },
    };
    const tio = {
      ...BASE_EVENT, description: 'Richest duplicate, keeps its identity.', imageUrl: '/images/events/x.webp',
      price: { amount: 25, currency: 'CHF', isFree: false },
    };
    for (const group of [[tio, guidle, mySwitzerland], [mySwitzerland, tio, guidle]]) {
      const winner = pickRichestEvent(group);
      expect(winner.id).toBe(tio.id);
      expect(winner.price).toMatchObject({ amount: 35, currency: 'CHF', priceSource: 'myswitzerland', priceField: 'offers.price' });
      expect(winner.price.priceConflicts).toEqual([
        { eventId: 'guidle:spengler', amount: 30, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'offers.price' },
        { eventId: 'tio-agenda:7001', amount: 25, currency: 'CHF', isFree: false },
      ]);
      expect(hasConfidentPrice(winner.price)).toBe(true);
    }
  });

  it('a structured price from a duplicate brings its own Offer metadata, never the winner ticket page', () => {
    const offerPrice = mySwitzerlandPrice('myswitzerland-offer.html');
    const mySwitzerland = { ...BASE_EVENT, id: 'myswitzerland:spengler', sourceKey: 'myswitzerland', price: offerPrice };
    const winner = {
      ...BASE_EVENT, id: 'guidle:spengler', sourceKey: 'guidle',
      description: 'Richest duplicate, keeps its identity.', imageUrl: '/images/events/x.webp',
      price: {
        amount: 25, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'price-accordion',
        url: 'https://tickets.example/guidle', availability: 'https://schema.org/SoldOut', validFrom: '2026-01-01',
      },
    };
    const merged = pickRichestEvent([winner, mySwitzerland]);
    expect(merged.id).toBe(winner.id);
    const { priceConflicts, ...price } = merged.price;
    expect(price).toEqual(offerPrice);
    expect(priceConflicts).toEqual([
      { eventId: 'guidle:spengler', amount: 25, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'price-accordion' },
    ]);
    const offers = (eventLd(merged as never, 'it') as Record<string, any>).offers;
    expect(offers.url).not.toBe(winner.price.url);
    expect(offers.availability).not.toBe(winner.price.availability);
  });

  it('a structured backfill from an earlier run outranks a fresh text price, not a fresh structured one', () => {
    const structured = { ...BASE_EVENT, id: 'myswitzerland:spengler', sourceKey: 'myswitzerland', price: mySwitzerlandPrice('myswitzerland-offer.html') };
    const freshText = { ...structured, price: mySwitzerlandPrice('myswitzerland-detail-table.html') };
    const [fromText] = applyKnownPriceBackfills([freshText], [structured]);
    expect(fromText.price).toMatchObject({ amount: structured.price.amount, priceSource: 'myswitzerland', priceField: 'offers.price' });
    expect(hasConfidentPrice(fromText.price)).toBe(true);
    const freshStructured = { ...structured, price: { amount: 40, currency: 'CHF', isFree: false, priceSource: 'myswitzerland', priceField: 'offers.price' } };
    expect(applyKnownPriceBackfills([freshStructured], [structured])[0]).toBe(freshStructured);
    expect(applyKnownPriceBackfills([freshText], [freshText])[0]).toBe(freshText);
  });

  it('Guidle structured price is used when MySwitzerland has none; text never outranks it', () => {
    const guidle = {
      ...BASE_EVENT, id: 'guidle:spengler', sourceKey: 'guidle',
      price: { amount: 30, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'offers.price' },
    };
    const mySwitzerlandText = {
      ...BASE_EVENT, id: 'myswitzerland:spengler', sourceKey: 'myswitzerland',
      price: mySwitzerlandPrice('myswitzerland-detail-table.html'),
    };
    const winner = pickRichestEvent([mySwitzerlandText, guidle]);
    expect(winner.price).toMatchObject({ amount: 30, priceSource: 'guidle', priceField: 'offers.price' });
    expect(winner.price.priceConflicts).toEqual([
      expect.objectContaining({ eventId: 'myswitzerland:spengler', amount: 5.3, priceField: 'detail-table' }),
    ]);
  });

  it('leaves a winner untouched when it already holds the chosen structured price and nobody disagrees', () => {
    const mySwitzerland = {
      ...BASE_EVENT, id: 'myswitzerland:spengler', sourceKey: 'myswitzerland', description: 'Richest duplicate.',
      price: mySwitzerlandPrice('myswitzerland-offer.html'),
    };
    const guidleText = {
      ...BASE_EVENT, id: 'guidle:spengler', sourceKey: 'guidle',
      price: { amount: 35, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'price-accordion' },
    };
    expect(pickRichestEvent([guidleText, mySwitzerland])).toBe(mySwitzerland);
  });

  it('agreeing text tariffs keep the provenance of their donor, so they stay unreliable', () => {
    const winner = { ...BASE_EVENT, description: 'Richest duplicate.', imageUrl: '/images/events/x.webp' };
    const accordion = {
      ...BASE_EVENT, id: 'guidle:festival', sourceKey: 'guidle',
      price: { amount: 18, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'price-accordion' },
    };
    const merged = pickRichestEvent([winner, accordion]);
    expect(merged.price).toEqual({ amount: 18, currency: 'CHF', isFree: false, priceSource: 'guidle', priceField: 'price-accordion' });
    expect(hasConfidentPrice(merged.price)).toBe(false);
  });
});

describe('Prezzi H5 delle fonti ammesse il 2026-10-05 (D4)', () => {
  describe('OpenAgenda `gratuit`: solo «gratuito», mai un importo', () => {
    it('gratuit: true → free, published as isAccessibleForFree with price 0', () => {
      const price = openAgendaGratuitPrice({ gratuit: true, conditions: 'Entrée libre, plateau à la sortie' });
      expect(price).toEqual({ amount: 0, currency: 'CHF', isFree: true, priceSource: 'openagenda', priceField: 'gratuit' });
      expect(hasConfidentPrice(price)).toBe(true);
      expect(isFromEventPrice(price)).toBe(false);
      const published = publishedPrice(price);
      expect(published.isAccessibleForFree).toBe(true);
      expect(published.offers).toMatchObject({ '@type': 'Offer', price: 0 });
      expect(visiblePrice(price)).toBe('Gratis');
    });

    it.each([
      ['gratuit: false', { gratuit: false, conditions: 'CHF 15.-' }],
      ['gratuit missing', { conditions: 'Gratuit' }],
      ['gratuit as a string', { gratuit: 'true' }],
      ['conditions only, with an amount', { conditions: 'Plein tarif CHF 25, réduit CHF 15' }],
    ])('%s → no price (conditions stays hidden)', (_label, event) => {
      expect(openAgendaGratuitPrice(event)).toBeUndefined();
    });
  });

  describe('Eventfrog `lowestTicketPrice`: «da CHF X», valuta da location.country, solo CH', () => {
    const ticketed = { lowestTicketPrice: 28, agendaEntryOnly: false, cancelled: false };

    it('Swiss location → from CHF 28, AggregateOffer.lowPrice, provenance of the currency kept', () => {
      const price = eventfrogLowestTicketPrice(ticketed, { country: 'CH' });
      expect(price).toEqual({
        amount: 28, currency: 'CHF', isFree: false, currencySource: 'location.country',
        priceSource: 'eventfrog', priceField: 'lowestTicketPrice',
      });
      expect(hasConfidentPrice(price)).toBe(true);
      expect(isFromEventPrice(price)).toBe(true);
      expect(publishedPrice(price).offers).toMatchObject({ '@type': 'AggregateOffer', lowPrice: 28, priceCurrency: 'CHF' });
      expect(publishedPrice(price).offers).not.toHaveProperty('price');
      expect(visiblePrice(price)).toBe('da CHF 28');
    });

    it.each([
      ['field missing', { agendaEntryOnly: false, cancelled: false }, { country: 'CH' }],
      ['field null', { ...ticketed, lowestTicketPrice: null }, { country: 'CH' }],
      ['zero amount', { ...ticketed, lowestTicketPrice: 0 }, { country: 'CH' }],
      ['currency unknown: no location', ticketed, undefined],
      ['currency unknown: location without country', ticketed, {}],
      ['country not CH (DE)', ticketed, { country: 'DE' }],
      ['country not CH (IT)', ticketed, { country: 'IT' }],
      ['agenda entry without ticketing', { ...ticketed, agendaEntryOnly: true }, { country: 'CH' }],
      ['agendaEntryOnly missing', { lowestTicketPrice: 28, cancelled: false }, { country: 'CH' }],
      ['cancelled event', { ...ticketed, cancelled: true }, { country: 'CH' }],
    ])('%s → no price', (_label, event, location) => {
      expect(eventfrogLowestTicketPrice(event as never, location as never)).toBeUndefined();
    });
  });

  describe('classicAscona `offers`: «da CHF X» per AggregateOffer, prezzo singolo per Offer', () => {
    it('AggregateOffer.lowPrice → from CHF 40 in the four locales, AggregateOffer with highPrice', () => {
      const price = { amount: 40, highPrice: 85, currency: 'CHF', isFree: false, priceSource: 'classicascona', priceField: 'offers.lowPrice' };
      expect(hasConfidentPrice(price)).toBe(true);
      expect(publishedPrice(price).offers).toMatchObject({ '@type': 'AggregateOffer', lowPrice: 40, highPrice: 85, priceCurrency: 'CHF' });
      expect(visiblePrice(price, 'it')).toBe('da CHF 40');
      expect(visiblePrice(price, 'en')).toBe('from CHF 40');
      expect(visiblePrice(price, 'de')).toBe('ab CHF 40');
      expect(visiblePrice(price, 'fr')).toBe('dès CHF 40');
    });

    it('Offer.price → a single price, rendered without «da»', () => {
      const price = { amount: 25, currency: 'CHF', isFree: false, priceSource: 'classicascona', priceField: 'offers.price' };
      expect(hasConfidentPrice(price)).toBe(true);
      expect(isFromEventPrice(price)).toBe(false);
      expect(publishedPrice(price).offers).toMatchObject({ '@type': 'Offer', price: 25 });
      expect(visiblePrice(price)).toBe('CHF 25');
    });
  });
});
