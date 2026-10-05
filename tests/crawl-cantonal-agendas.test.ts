/**
 * Cantonal agenda crawlers added in P9a (fr.ch, nw.ch, ow.ch, stadtluzern.ch)
 * on the shared createAgendaCrawler factory. Pure parsing only — no network.
 * Fixtures under tests/fixtures/events-agendas/ are trimmed real responses
 * captured on 2026-10-05 (the Luzern `<author>` contact is redacted).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFribourgEventsFeed, parseFeedDateTime, parseFeedGps, FEED_URL } from '../scripts/crawl-fr-agenda.mjs';
import { parseIcmsAnlaesseHtml, parseIcmsTermineRss, parseIcmsTime, parseRssEventDate } from '../scripts/lib/icms-agenda.mjs';
import { ICMS_AGENDAS, parserFor } from '../scripts/crawl-icms-agenda.mjs';
import { EVENT_SOURCES } from '../scripts/lib/events-utils.mjs';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'events-agendas', name), 'utf8');

describe('EVENT_SOURCES entries for the cantonal agendas', () => {
  it.each([
    ['fr-agenda', 'FR'],
    ['nw-agenda', 'NW'],
    ['ow-agenda', 'OW'],
    ['lu-stadt-agenda', 'LU'],
  ])('%s is a canton-scoped source (%s)', (key, canton) => {
    expect(EVENT_SOURCES[key]).toMatchObject({ key, canton });
    expect(EVENT_SOURCES[key].homepage).toMatch(/^https:\/\//);
  });

  it('every iCMS agenda has a matching source entry and parser', () => {
    for (const key of Object.keys(ICMS_AGENDAS)) {
      expect(EVENT_SOURCES[key]?.key).toBe(key);
      expect(typeof parserFor(key)).toBe('function');
    }
    expect(() => parserFor('nope')).toThrow(/unknown iCMS agenda/);
  });

  it('fetches the State of Fribourg events feed', () => {
    expect(FEED_URL).toBe('https://www.fr.ch/evenements/rss.xml');
  });
});

describe('fr.ch events feed', () => {
  const events = parseFribourgEventsFeed(fixture('fr-ch-evenements.xml'));

  it('maps the structured event fields of each item', () => {
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: 'fr-agenda:bouger-decouvrir-partager-un-apres-midi-pour-les-60',
      title: 'Bouger, découvrir, partager : un après-midi pour les 60+',
      startDate: '2026-10-10',
      startTime: '13:30',
      category: 'Manifestation',
      description: expect.stringContaining('Pro Senectute Fribourg'),
      venue: 'Murten',
      comune: 'Murten',
      comuneMatch: 'exact',
      canton: 'FR',
      url: 'https://www.fr.ch/dsas/ssp/evenements/bouger-decouvrir-partager-un-apres-midi-pour-les-60',
      imageUrl: 'https://www.fr.ch/sites/default/files/2026-09/apresmidi-decouverte-sportive-60%2B-morat.png',
      address: { street: 'Wilerweg 53', postalCode: '3280', locality: 'Murten' },
      geo: { lat: 46.9232041, lng: 7.1240511 },
      organizer: { '@type': 'Organization', name: 'Service de la santé publique' },
    });
  });

  it('keeps a multi-day range and decodes entities in the organizer', () => {
    expect(events[1]).toMatchObject({
      id: 'fr-agenda:corpus-v-le-corps-liquide',
      startDate: '2026-11-27',
      endDate: '2027-02-28',
      startTime: '11:00',
      canton: 'FR',
      comune: 'Fribourg',
    });
    expect(events[1].organizer.name).toBe('Musée d’art et d’histoire MAHF & Espace Jean Tinguely – Niki de Saint Phalle');
  });

  it('skips an item without a usable start date instead of guessing one', () => {
    const xml = `<rss><channel>
      <item><title>Sans date</title><link>https://www.fr.ch/x/evenements/sans-date</link></item>
      <item><title>Date fausse</title><link>https://www.fr.ch/x/evenements/fausse</link><event:startDate>2026-02-31T10:00:00+01:00</event:startDate></item>
      <item><title>Hors domaine</title><link>https://example.org/evenements/x</link><event:startDate>2026-10-10T10:00:00+02:00</event:startDate></item>
    </channel></rss>`;
    expect(parseFribourgEventsFeed(xml)).toEqual([]);
    expect(parseFribourgEventsFeed('not xml <<<')).toEqual([]);
  });

  it('reads the date in the feed offset, never through UTC', () => {
    expect(parseFeedDateTime('2026-10-10T00:30:00+02:00')).toEqual({ day: '2026-10-10', time: '00:30' });
    expect(parseFeedDateTime('2026-10-10T00:00:00+02:00')).toEqual({ day: '2026-10-10', time: undefined });
    expect(parseFeedDateTime('')).toBeNull();
  });

  it('accepts only a sane coordinate pair', () => {
    expect(parseFeedGps('46.80,7.15')).toEqual({ lat: 46.8, lng: 7.15 });
    expect(parseFeedGps('46.80')).toBeUndefined();
    expect(parseFeedGps('146.80,7.15')).toBeUndefined();
  });
});

describe('iCMS "Anlässe" page (nw.ch / ow.ch)', () => {
  const source = { sourceKey: 'nw-agenda', canton: 'NW', origin: 'https://www.nw.ch' };
  const events = parseIcmsAnlaesseHtml(fixture('nw-anlaesseaktuelles.html'), source);

  it('reads the events table and ignores the other data-entities tables', () => {
    expect(events.map((event) => event.id)).toEqual([
      'nw-agenda:88340', expect.stringMatching(/^nw-agenda:\d+$/), expect.stringMatching(/^nw-agenda:\d+$/), expect.stringMatching(/^nw-agenda:\d+$/),
    ]);
    expect(events[0]).toEqual({
      id: 'nw-agenda:88340',
      title: 'Montags-Jass Stans',
      startDate: '2026-10-05',
      startTime: '13:30',
      venue: 'Pfarreiheim, Stans',
      comune: 'Stans',
      comuneMatch: 'exact',
      canton: 'NW',
      url: 'https://www.nw.ch/_rte/anlass/88340',
      address: { locality: 'Stans' },
      organizer: { '@type': 'Organization', name: 'Frauen Gemeinschaft Stans' },
    });
  });

  it('keeps a multi-day range and strips a postal-code prefix from the locality', () => {
    expect(events[1]).toMatchObject({ startDate: '2026-09-26', endDate: '2026-10-11', comune: 'Emmetten', canton: 'NW' });
    expect(events[2]).toMatchObject({ comune: 'Stans', address: { locality: 'Stans' }, startTime: '17:00' });
  });

  it('keeps the agenda canton when the locality names no comune', () => {
    // "Flüeli Ranft" is a locality of Sachseln (OW), not a municipality name:
    // no comune can be named, so the agenda's own canton stands.
    expect(events[3]).toMatchObject({ canton: 'NW', address: { locality: 'Flüeli Ranft' } });
    expect(events[3].comune).toBeUndefined();
  });

  it('attributes a row to the canton of the comune its locality names', () => {
    const row = { id: '1', name: '<a href="/_rte/anlass/1">Konzert</a>', _datumVon: '2026-10-10', _ort: 'Sachseln' };
    const html = `<div data-entities="${JSON.stringify({ data: [row] }).replace(/"/g, '&quot;')}"></div>`;
    expect(parseIcmsAnlaesseHtml(html, source)[0]).toMatchObject({ comune: 'Sachseln', canton: 'OW' });
  });

  it('skips a row without a valid start day', () => {
    const rows = [
      { id: '2', name: 'Ohne Datum', _datumVon: '' },
      { id: '3', name: 'Falsches Datum', _datumVon: '2026-13-01' },
      { id: 'x', name: 'Keine ID', _datumVon: '2026-10-10' },
    ];
    const html = `<div data-entities="${JSON.stringify({ data: rows }).replace(/"/g, '&quot;')}"></div>`;
    expect(parseIcmsAnlaesseHtml(html, source)).toEqual([]);
  });

  it('parses the listing time format', () => {
    expect(parseIcmsTime('9.00 Uhr')).toBe('09:00');
    expect(parseIcmsTime('13:30')).toBe('13:30');
    expect(parseIcmsTime('ganztags')).toBeUndefined();
    expect(parseIcmsTime('25.00 Uhr')).toBeUndefined();
  });
});

describe('iCMS events RSS (stadtluzern.ch termine.rss)', () => {
  const events = parseIcmsTermineRss(fixture('stadtluzern-termine.rss'), { sourceKey: 'lu-stadt-agenda', canton: 'LU' });

  it('reads ev:startdate / ev:enddate and never the author contact', () => {
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'lu-stadt-agenda:6840391',
      title: 'Kunstausstellung Weltformat',
      startDate: '2026-10-03',
      endDate: '2026-10-10',
      canton: 'LU',
      comune: 'Luzern',
      url: 'https://www.stadtluzern.ch/_rte/anlass/6840391',
    });
    expect(events[0].startTime).toBeUndefined();
    expect(events[1]).toMatchObject({ startDate: '2026-10-09', startTime: '12:00', canton: 'LU' });
    expect(events[1].imageUrl).toMatch(/^https:\/\/pcdn1\.i-web\.ch\//);
    expect(JSON.stringify(events)).not.toContain('@');
  });

  it('parses the RSS event-module date shapes', () => {
    expect(parseRssEventDate('2026-10-03 ')).toEqual({ day: '2026-10-03', time: undefined });
    expect(parseRssEventDate('2026-10-09 12:00:00')).toEqual({ day: '2026-10-09', time: '12:00' });
    expect(parseRssEventDate('09.10.2026')).toBeNull();
  });
});
