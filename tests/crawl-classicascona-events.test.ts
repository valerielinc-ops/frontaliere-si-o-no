/**
 * classicAscona (Settimane Musicali di Ascona), owner decisions D3/D4 of
 * 2026-10-05: facts only from the organizer's MusicEvent JSON-LD, and the
 * JSON-LD `offers` as an admitted price field («da CHF X» for an
 * AggregateOffer, a single price for an Offer, nothing for free concerts).
 *
 * Fixtures under tests/fixtures/events-agendas/classicascona-*.html are real
 * concert pages read on 2026-10-05, trimmed to the JSON-LD block and the
 * «Categorie di prezzo» card; the organizer's prose is replaced by a marker so
 * the repository does not carry it. No network.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  POLITE_DELAY_MS,
  SITEMAP_URL,
  concertDescriptionByLocale,
  createClassicAsconaCrawler,
  parseConcertPage,
  parseConcertSitemap,
  shownTariffs,
  urlsToFetch,
} from '../scripts/crawl-classicascona-events.mjs';
import { parseJsonLdBlock } from '../scripts/lib/organizer-jsonld.mjs';
import { EVENT_SOURCES, hasConfidentPrice, isFromEventPrice } from '../scripts/lib/events-utils.mjs';
import { dedupeOrganizerAgainstTio } from '../scripts/assemble-events-dataset.mjs';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'events-agendas', name), 'utf8');

const PAGES = {
  galliano: { file: 'classicascona-galliano.html', url: 'https://classicascona.ch/concerti/richard-galliano-new-viaggio-trio/' },
  yudin: { file: 'classicascona-ng21-yudin.html', url: 'https://classicascona.ch/concerti/next-generation-xxi-dmitry-yudin/' },
  evensong: { file: 'classicascona-ng14-evensong.html', url: 'https://classicascona.ch/concerti/next-generation-xiv-ascona-choral-academy-evensong/' },
  tallis: { file: 'classicascona-tallis.html', url: 'https://classicascona.ch/concerti/canti-medievali-lamentazioni-di-tallis/' },
} as const;

const ORGANIZER_PROSE_MARKER = 'testo descrittivo dell organizzatore';
const silent = () => {};

function parsePage(key: keyof typeof PAGES, transform: (html: string) => string = (html) => html, log: (line: string) => void = silent) {
  const { file, url } = PAGES[key];
  return parseConcertPage(transform(fixture(file)), url, { log });
}

describe('classicAscona source registry entry', () => {
  it('is a Ticino source, read from the sitemap with at least 1 s between pages', () => {
    expect(EVENT_SOURCES.classicascona).toMatchObject({ key: 'classicascona', canton: 'TI' });
    expect(SITEMAP_URL).toBe('https://classicascona.ch/konzerte-sitemap1.xml');
    expect(POLITE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('concert sitemap', () => {
  it('keeps only the Italian /concerti/<slug>/ pages, without the listing page and the de/en twins', () => {
    const xml = fixture('classicascona-konzerte-sitemap1.xml');
    const urls = parseConcertSitemap(xml);
    const italianConcerts = [...xml.matchAll(/<loc>(https:\/\/classicascona\.ch\/concerti\/[^<]+\/)<\/loc>/g)].map((m) => m[1]);
    expect(urls).toEqual(italianConcerts);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain(PAGES.galliano.url);
    expect(urls).not.toContain('https://classicascona.ch/concerti/');
    expect(urls.every((url) => !/\/(?:de|en)\//.test(url))).toBe(true);
  });

  it('skips the concerts already in the slice with a past date, re-reads the others', () => {
    const urls = [PAGES.evensong.url, PAGES.galliano.url, PAGES.yudin.url];
    const slice = [
      { url: PAGES.evensong.url, startDate: '2026-10-05' },
      { url: PAGES.galliano.url, startDate: '2026-10-07' },
    ];
    expect(urlsToFetch(urls, slice, '2026-10-06')).toEqual([PAGES.galliano.url, PAGES.yudin.url]);
    expect(urlsToFetch(urls, [], '2026-10-06')).toEqual(urls);
  });
});

describe('concert page → event (facts only)', () => {
  it('AggregateOffer → «da CHF 40» with provenance, highPrice kept, facts mapped', () => {
    const [event] = parsePage('galliano');
    expect(event).toMatchObject({
      id: 'classicascona:richard-galliano-new-viaggio-trio',
      title: 'Richard Galliano – New Viaggio Trio',
      startDate: '2026-10-07',
      startTime: '19:30',
      category: 'musica',
      venue: 'Chiesa del Collegio Papio, Ascona',
      address: { street: 'Via delle Cappelle 1', postalCode: '6612', locality: 'Ascona' },
      comune: 'Ascona',
      canton: 'TI',
      url: PAGES.galliano.url,
      price: {
        amount: 40, highPrice: 85, currency: 'CHF', isFree: false,
        priceSource: 'classicascona', priceField: 'offers.lowPrice',
        url: 'https://www.kulturticket.ch/it/50028/classicAscona/event/1787',
      },
      performer: [
        { '@type': 'Person', name: 'Richard Galliano' },
        { '@type': 'Person', name: 'Adrien Moignard' },
        { '@type': 'Person', name: 'Philippe Aerts' },
      ],
      organizer: { '@type': 'Organization', name: 'classicAscona' },
    });
    expect(hasConfidentPrice(event.price)).toBe(true);
    expect(isFromEventPrice(event.price)).toBe(true);
  });

  it('never copies the organizer description, images, performer links or the synthetic end time', () => {
    for (const key of Object.keys(PAGES) as Array<keyof typeof PAGES>) {
      const [event] = parsePage(key);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(ORGANIZER_PROSE_MARKER);
      expect(serialized).not.toContain('wp-content');
      expect(serialized).not.toContain('/artists/');
      expect(serialized).not.toContain('youtube');
      expect(event).not.toHaveProperty('imageUrl');
      expect(event).not.toHaveProperty('endDate');
    }
  });

  it('Offer.price → a single price; «Locarno, Svizzera» becomes the locality Locarno', () => {
    const [event] = parsePage('yudin');
    expect(event.price).toMatchObject({ amount: 25, currency: 'CHF', isFree: false, priceSource: 'classicascona', priceField: 'offers.price' });
    expect(event.price).not.toHaveProperty('highPrice');
    expect(isFromEventPrice(event.price)).toBe(false);
    expect(event).toMatchObject({ comune: 'Locarno', address: { locality: 'Locarno', postalCode: '6600' } });
  });

  it('a free «Next Generation» concert (Offer without price, page shows CHF 0) → no price', () => {
    expect(shownTariffs(fixture(PAGES.evensong.file))).toEqual([0]);
    const [event] = parsePage('evensong');
    expect(event.id).toBe('classicascona:next-generation-xiv-ascona-choral-academy-evensong');
    expect(event).not.toHaveProperty('price');
  });

  it('decodes HTML entities in the JSON-LD name', () => {
    const [event] = parsePage('tallis');
    expect(event.title).toBe('Canti medievali & Lamentazioni di Tallis');
    expect(event.price).toMatchObject({ amount: 20, highPrice: 60, priceField: 'offers.lowPrice' });
  });

  it('price 0 without isAccessibleForFree is discarded, never «free»', () => {
    const lines: string[] = [];
    const [event] = parsePage('yudin', (html) => html.replace('"price": 25', '"price": 0').replace('>CHF 25<', '>CHF 0<'), (line) => lines.push(line));
    expect(event).not.toHaveProperty('price');
    expect(lines.join('\n')).toMatch(/price dropped/);
  });

  it('structured amounts not among the tariffs shown on the page → price dropped with a log line', () => {
    const lines: string[] = [];
    const [event] = parsePage('galliano', (html) => html.replace('CHF 85 / 70 / 55 / 40', 'CHF 90 / 70 / 55'), (line) => lines.push(line));
    expect(event).not.toHaveProperty('price');
    expect(lines.join('\n')).toMatch(/richard-galliano-new-viaggio-trio: price dropped — structured 40\/85 not among the shown tariffs 90\/70\/55/);
  });

  it('no price card on the page → nothing to cross-check against → no price', () => {
    const lines: string[] = [];
    const [event] = parsePage('yudin', (html) => html.replace(/<div class="brxe-block card-info">[\s\S]*<\/body>/, '</body>'), (line) => lines.push(line));
    expect(event).not.toHaveProperty('price');
    expect(lines.join('\n')).toMatch(/not among the shown tariffs \(none\)/);
  });

  it('a cancelled concert or a page without an Event JSON-LD yields nothing', () => {
    expect(parsePage('galliano', (html) => html.replace('EventScheduled', 'EventCancelled'))).toEqual([]);
    expect(parsePage('galliano', (html) => html.replace('"MusicEvent"', '"WebPage"'))).toEqual([]);
  });

  it('tolerates raw line breaks inside JSON-LD strings', () => {
    expect(parseJsonLdBlock('{"@type":"MusicEvent","name":"Riga\nspezzata"}')).toEqual({ '@type': 'MusicEvent', name: 'Riga\nspezzata' });
    expect(parseJsonLdBlock('{not json')).toBeUndefined();
  });
});

describe('our description from the facts, in the four locales', () => {
  const facts = {
    title: 'Richard Galliano – New Viaggio Trio',
    startDate: '2026-10-07',
    startTime: '19:30',
    venue: 'Chiesa del Collegio Papio, Ascona',
    locality: 'Ascona',
    performers: ['Richard Galliano', 'Adrien Moignard'],
  };

  it('names title, date, time, venue and performers in it/en/de/fr', () => {
    const byLocale = concertDescriptionByLocale(facts);
    expect(Object.keys(byLocale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(byLocale.it).toContain('mercoledì 7 ottobre 2026 alle 19:30');
    expect(byLocale.en).toContain('Wednesday 7 October 2026 at 19:30');
    expect(byLocale.de).toContain('Mittwoch, 7. Oktober 2026 um 19:30 Uhr');
    expect(byLocale.fr).toContain('mercredi 7 octobre 2026 à 19:30');
    for (const text of Object.values(byLocale)) {
      expect(text).toContain(facts.title);
      expect(text).toContain('Chiesa del Collegio Papio, Ascona');
      expect(text).toContain('Richard Galliano, Adrien Moignard');
      expect(text).not.toMatch(/CHF/);
      expect(text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(20);
    }
  });

  it('is what the event carries, in every locale', () => {
    const [event] = parsePage('galliano');
    expect(event.descriptionByLocale.it).toBe(event.description);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(event.descriptionByLocale[locale]).toContain('Richard Galliano – New Viaggio Trio');
    }
  });
});

describe('crawl through the agenda factory (recorded pages, temporary slice)', () => {
  it('writes the slice with prices only where the JSON-LD has a structured amount, no images', async () => {
    const urls = Object.values(PAGES).map(({ url }) => url);
    const bodyFor = new Map(Object.values(PAGES).map(({ url, file }) => [url, fixture(file)]));
    const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classicascona-slice-'));
    const fetchImpl = (async (url: string) => {
      const body = bodyFor.get(url);
      return { ok: body !== undefined, status: body ? 200 : 404, text: async () => body ?? '' };
    }) as never;
    const result = await createClassicAsconaCrawler(urls, { fetchImpl, sliceDir, politeDelayMs: 0 }).crawl();
    expect(result.written).toBe(true);
    const slice = JSON.parse(fs.readFileSync(path.join(sliceDir, 'classicascona.json'), 'utf8'));
    expect(slice.events.map((event: { id: string }) => event.id).sort()).toEqual(
      urls.map((url) => `classicascona:${url.split('/').filter(Boolean).pop()}`).sort(),
    );
    const priced = slice.events.filter((event: { price?: unknown }) => hasConfidentPrice(event.price));
    expect(priced.map((event: { id: string }) => event.id).sort()).toEqual([
      'classicascona:canti-medievali-lamentazioni-di-tallis',
      'classicascona:next-generation-xxi-dmitry-yudin',
      'classicascona:richard-galliano-new-viaggio-trio',
    ]);
    expect(slice.events.every((event: { imageUrl?: unknown; sourceKey?: string }) => !event.imageUrl && event.sourceKey === 'classicascona')).toBe(true);
  });
});

describe('assemble: classicAscona vs tio.ch (rule 3b)', () => {
  // Shapes of the real tio-agenda records of 2026-10-05 (ids, titles, venues,
  // comuni and tio's own text prices), trimmed.
  const tio = (id: string, title: string, startDate: string, comune: string, price?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: `tio-agenda:${id}`, sourceKey: 'tio-agenda', title, startDate, comune, canton: 'TI',
    description: 'Testo della scheda tio.', imageUrl: '/images/events/tio.webp', geo: { lat: 46.155, lng: 8.771 },
    ...(price ? { price } : {}), ...extra,
  });
  const organizer = (key: keyof typeof PAGES) => ({ ...parsePage(key)[0], sourceKey: 'classicascona' });

  it('merges each concert with its re-titled tio twin; the structured tariff wins and the conflict is recorded', () => {
    const tioEvensong = tio('62669', 'Next Generation | Evensong', '2026-10-05', 'Ascona', { amount: 0, currency: 'CHF', isFree: true }, { endDate: '2026-10-09' });
    const tioEvensongSameDay = tio('62691', 'Next Generation | Evensong', '2026-10-07', 'Ascona', { amount: 0, currency: 'CHF', isFree: true });
    const tioGalliano = tio('62694', 'Richard Galliano | Nuovo Viaggio Trio', '2026-10-07', 'Ascona', { amount: 20, currency: 'CHF', isFree: false });
    const tioYudin = tio('62697', 'Costellazione giovani | Next Generation XXI', '2026-10-10', 'Locarno', { amount: 25, currency: 'CHF', isFree: false });
    const tioPace = tio('62563', 'Concerto per la pace', '2026-10-10', 'Locarno');
    const input = [tioEvensong, tioEvensongSameDay, tioGalliano, tioYudin, tioPace, organizer('galliano'), organizer('evensong'), organizer('yudin')];

    const { events, mergedAway } = dedupeOrganizerAgainstTio(input);
    expect(mergedAway).toBe(3);
    expect(events.filter((event) => event.sourceKey === 'classicascona')).toEqual([]);

    const galliano = events.find((event) => event.id === 'tio-agenda:62694')!;
    expect(galliano.price).toMatchObject({ amount: 40, highPrice: 85, priceSource: 'classicascona', priceField: 'offers.lowPrice' });
    expect(galliano.price.priceConflicts).toEqual([{ eventId: 'tio-agenda:62694', amount: 20, currency: 'CHF', isFree: false }]);
    expect(hasConfidentPrice(galliano.price)).toBe(true);

    const yudin = events.find((event) => event.id === 'tio-agenda:62697')!;
    expect(yudin.price).toMatchObject({ amount: 25, priceSource: 'classicascona', priceField: 'offers.price' });

    // The same-evening Evensong in Ascona keeps its own record: it shares no
    // distinctive word with Galliano.
    expect(events.find((event) => event.id === 'tio-agenda:62691')).toBe(tioEvensongSameDay);
    // The 05-10 Evensong merges with the organizer concert of that day, and its
    // free text price stays unpublished (no structured source).
    const evensong = events.find((event) => event.id === 'tio-agenda:62669')!;
    expect(hasConfidentPrice(evensong.price)).toBe(false);
    expect(events.find((event) => event.id === 'tio-agenda:62563')).toBe(tioPace);
  });

  it('matches through the URL slug when the organizer title is in another language', () => {
    const hymn = {
      ...organizer('tallis'), id: 'classicascona:inno-alla-bellezza-celeste', title: 'A Hymn of Heavenly Beauty',
      startDate: '2026-10-09', url: 'https://classicascona.ch/concerti/inno-alla-bellezza-celeste/',
    };
    const tioHymn = tio('62696', 'Un inno di bellezza celeste', '2026-10-09', 'Ascona', { amount: 60, currency: 'CHF', isFree: false });
    const { events, mergedAway } = dedupeOrganizerAgainstTio([tioHymn, hymn]);
    expect(mergedAway).toBe(1);
    expect(events.map((event) => event.id)).toEqual(['tio-agenda:62696']);
  });

  it('does not merge across comuni or days, and a tie merges nothing', () => {
    const galliano = organizer('galliano');
    const otherComune = tio('1', 'Richard Galliano | Nuovo Viaggio Trio', '2026-10-07', 'Locarno');
    const otherDay = tio('2', 'Richard Galliano | Nuovo Viaggio Trio', '2026-10-08', 'Ascona');
    expect(dedupeOrganizerAgainstTio([otherComune, otherDay, galliano]).mergedAway).toBe(0);

    const twinA = tio('3', 'Richard Galliano', '2026-10-07', 'Ascona');
    const twinB = tio('4', 'Galliano, Richard', '2026-10-07', 'Ascona');
    const tie = dedupeOrganizerAgainstTio([twinA, twinB, galliano]);
    expect(tie.mergedAway).toBe(0);
    expect(tie.events).toHaveLength(3);
  });
});
