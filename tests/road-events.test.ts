/**
 * Road events dataset (scripts/collect-road-events.mjs): DATEX II situation
 * parsing, canton resolution from the committed gazetteer, cantonal feed
 * filtering, and the structural gate the collector runs before writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROAD_EVENT_FEEDS,
  buildCantonGazetteer,
  buildCantonGroupMap,
  carryForwardFailedSources,
  classifyRoadEventType,
  dedupeRoadEvents,
  feedItemsToEvents,
  isMobilityRelevant,
  parseDatexSituations,
  parseFeedItems,
  resolveCantonFromTexts,
  validateRoadEventsPayload,
} from '../scripts/lib/road-events.mjs';

const ROOT = path.resolve(__dirname, '..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const gazetteer = buildCantonGazetteer({
  municipalities: readJson('data/canton-municipalities.json'),
  localities: readJson('data/swiss-locality-postal-codes.json'),
});
const cantonUrlSlugs = readJson('data/canton-url-slugs.json');
const toGroup = buildCantonGroupMap(cantonUrlSlugs);
const NOW = new Date('2026-10-05T10:00:00Z');

/** One DATEX situation in the shape the ASTRA pull returns (trimmed). */
function situation(id: string, { de, it, type = 'MaintenanceWorks', start, end, coords }: {
  de: string; it?: string; type?: string; start: string; end: string; coords?: [number, number];
}) {
  const point = coords
    ? `<dx223:pointCoordinates><dx223:latitude>${coords[0]}</dx223:latitude><dx223:longitude>${coords[1]}</dx223:longitude></dx223:pointCoordinates>`
    : '';
  return `<dx223:situation xsi:type="dx223:Situation" id="${id}" version="0">
<dx223:situationRecord xsi:type="dx223:${type}" id="${id}.1" version="0">
<dx223:validity><dx223:validityStatus>active</dx223:validityStatus><dx223:validityTimeSpecification>
<dx223:overallStartTime>${start}</dx223:overallStartTime>
<dx223:validPeriod><dx223:startOfPeriod>${start}</dx223:startOfPeriod><dx223:endOfPeriod>${end}</dx223:endOfPeriod></dx223:validPeriod>
</dx223:validityTimeSpecification></dx223:validity>
<dx223:generalPublicComment><dx223:comment><dx223:values>
<dx223:value lang="de-CH">${de}</dx223:value>
${it ? `<dx223:value lang="it-CH">${it}</dx223:value>` : ''}
</dx223:values></dx223:comment></dx223:generalPublicComment>
${type === 'RoadOrCarriagewayOrLaneManagement' ? '<dx223:roadOrCarriagewayOrLaneManagementType>roadClosed</dx223:roadOrCarriagewayOrLaneManagementType>' : ''}
<dx223:groupOfLocations>${point}</dx223:groupOfLocations>
</dx223:situationRecord></dx223:situation>`;
}

const DATEX = `<?xml version="1.0"?><SOAP-ENV:Envelope><SOAP-ENV:Body><dx223:d2LogicalModel><dx223:payloadPublication>
${situation('s.1', {
  de: 'Freigegeben: A1 Bern &lt;-&gt; Zürich Anschluss Wangen an der Aare Sachlage: Verkehrsbehinderung Baustelle Dauer: bis 31.10.2026',
  it: 'Approvato: A1 Berna &lt;-&gt; Zurigo Svincolo autostradale Wangen an der Aare Situazione: problemi di traffico cantiere Durata: fino 31.10.2026',
  start: '2026-09-01T05:00:00Z', end: '2026-10-31T16:00:00Z',
})}
${situation('s.2', {
  de: 'Freigegeben: A2 Luzern -&gt; Basel zwischen Anschluss Liestal und Anschluss Pratteln Sachlage: gesperrt',
  type: 'RoadOrCarriagewayOrLaneManagement',
  start: '2026-10-04T20:00:00Z', end: '2026-10-06T04:00:00Z',
})}
${situation('s.3', {
  de: 'Freigegeben: A1 Genf -&gt; Lausanne zwischen Anschluss Versoix und Anschluss Coppet Sachlage: Baustelle',
  start: '2026-09-01T05:00:00Z', end: '2026-12-31T16:00:00Z',
})}
${situation('s.4', {
  de: 'Freigegeben: A2 Chiasso -&gt; Gotthard Ortschaft Mendrisio Sachlage: Baustelle',
  start: '2025-01-01T05:00:00Z', end: '2026-09-30T16:00:00Z',
})}
${situation('s.5', {
  de: 'Freigegeben: Unbekanntstrasse Sachlage: Baustelle',
  start: '2026-09-01T05:00:00Z', end: '2026-12-31T16:00:00Z',
})}
${situation('s.6', {
  de: 'Freigegeben: Bösingenstrasse, 3177 Laupen, Switzerland in alle Richtungen Sachlage: gesperrt',
  type: 'RoadOrCarriagewayOrLaneManagement',
  start: '2026-10-01T05:00:00Z', end: '2026-10-20T16:00:00Z',
  coords: [46.9, 7.24],
})}
</dx223:payloadPublication></dx223:d2LogicalModel></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

describe('road events — DATEX II situations', () => {
  const { events, stats } = parseDatexSituations(DATEX, { gazetteer, toGroup, now: NOW });
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));

  it('resolves the canton from the interchange/locality names in the text', () => {
    expect(byId['astra-datex2:s.1']).toMatchObject({ canton: 'BE', type: 'cantiere', source: 'astra-datex2', url: null });
    expect(byId['astra-datex2:s.1'].title).toMatch(/^A1 Berna <-> Zurigo Svincolo autostradale Wangen an der Aare/);
    expect(byId['astra-datex2:s.1'].titleByLocale.de).toMatch(/^A1 Bern <-> Zürich/);
  });

  it('files BL/BS under the BASILEA URL group and flags closures', () => {
    expect(byId['astra-datex2:s.2']).toMatchObject({ canton: 'BASILEA', type: 'chiusura' });
  });

  it('drops a stretch whose places resolve to two cantons instead of guessing one', () => {
    expect(byId['astra-datex2:s.3']).toBeUndefined();
  });

  it('drops expired situations and situations with no resolvable place', () => {
    expect(byId['astra-datex2:s.4']).toBeUndefined();
    expect(byId['astra-datex2:s.5']).toBeUndefined();
    expect(stats).toMatchObject({ situations: 6, expired: 1, unresolved: 2, kept: 3 });
  });

  it('uses a postal code when the situation is an address, and keeps coordinates', () => {
    expect(byId['astra-datex2:s.6']).toMatchObject({ canton: 'BE', type: 'chiusura', geo: { lat: 46.9, lng: 7.24 } });
  });

  it('carries the validity window of the records', () => {
    expect(byId['astra-datex2:s.1']).toMatchObject({
      validFrom: '2026-09-01T05:00:00.000Z',
      validTo: '2026-10-31T16:00:00.000Z',
      observedAt: NOW.toISOString(),
    });
  });
});

describe('road events — canton gazetteer', () => {
  it('leaves ambiguous names out (no single canton)', () => {
    expect(resolveCantonFromTexts(['Freigegeben: X Ortschaft Buchs Sachlage: gesperrt'], gazetteer)).toBeNull();
  });

  it('drops a situation whose texts name different cantons, at every stage', () => {
    const g = { byCap: new Map(), byName: new Map([['Foo', 'GE'], ['Bar', 'VD']]) };
    expect(resolveCantonFromTexts(['Svincolo autostradale Foo', 'Svincolo autostradale Bar'], g)).toBeNull();
    expect(resolveCantonFromTexts(['Foo', 'Bar'], g)).toBeNull();
    expect(resolveCantonFromTexts(['Svincolo autostradale Foo', 'Anschluss Foo'], g)).toBe('GE');
    const withCap = { byCap: new Map([['1000', 'VD']]), byName: new Map([['Foo', 'GE']]) };
    expect(resolveCantonFromTexts(['1000 Lausanne', 'Svincolo Foo'], withCap)).toBeNull();
    expect(resolveCantonFromTexts(['1000 Lausanne', 'Svincolo autostradale Foo'], withCap)).toBeNull();
  });

  it('maps exonyms the DATEX texts use', () => {
    expect(resolveCantonFromTexts(['Approvato: A12 Vevey <-> Friborgo tra Svincolo autostradale Friborgo-Sud E Luogo Matran Situazione:'], gazetteer)).toBe('FR');
  });
});

describe('road events — cantonal feeds', () => {
  const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Fermeture de la route cantonale entre Morat et Fribourg</title><link>https://www.fr.ch/a</link><pubDate>Thu, 01 Oct 2026 08:52:05 +0200</pubDate><description>Course pédestre</description></item>
<item><title>Fermeture temporaire des caisses du service des contraventions</title><link>https://www.fr.ch/b</link><pubDate>Mon, 28 Sep 2026 10:08:16 +0200</pubDate></item>
<item><title>Commandes frauduleuses en ligne</title><link>https://www.fr.ch/c</link><pubDate>Tue, 22 Sep 2026 07:50:17 +0200</pubDate></item>
<item><title>Accident mortel de la circulation à Renens</title><link>https://www.fr.ch/d</link><pubDate>Sun, 20 Sep 2026 12:12:16 +0200</pubDate></item>
<item><title>Vieux comunicato</title><link>https://www.fr.ch/e</link><pubDate>Mon, 01 Jun 2026 12:00:00 +0200</pubDate></item>
<item><title>Senza data, route fermée</title><link>https://www.fr.ch/f</link></item>
</channel></rss>`;
  const feed = ROAD_EVENT_FEEDS.find((f) => f.id === 'fr-police')!;

  it('parses RSS items with ISO dates', () => {
    const items = parseFeedItems(rss);
    expect(items).toHaveLength(6);
    expect(items[0]).toMatchObject({ url: 'https://www.fr.ch/a', publishedAt: '2026-10-01T06:52:05.000Z' });
  });

  it('keeps only dated, recent, road-related items of a keyword-filtered feed', () => {
    const events = feedItemsToEvents(feed, parseFeedItems(rss), { now: NOW });
    expect(events.map((e) => e.url)).toEqual(['https://www.fr.ch/a', 'https://www.fr.ch/d']);
    expect(events[0]).toMatchObject({ canton: 'FR', type: 'chiusura', source: 'fr-police', validFrom: null, validTo: null });
    expect(events[1].type).toBe('traffico');
  });

  it('parses Atom entries too', () => {
    const atom = `<feed><entry><title>Strassensperrung Hauptstrasse</title><link href="https://www.ai.ch/x"/><updated>2026-10-02T08:00:00Z</updated></entry></feed>`;
    expect(parseFeedItems(atom)[0]).toMatchObject({ title: 'Strassensperrung Hauptstrasse', url: 'https://www.ai.ch/x' });
  });

  it('accepts transport-operator disruptions only on transit feeds', () => {
    expect(isMobilityRelevant('slowUp: Busumleitungen am Sonntag', { transit: true })).toBe(true);
    expect(isMobilityRelevant('Auf der Suche nach einem originellen Geschenk?', { transit: true })).toBe(false);
    expect(classifyRoadEventType('Tarifs à compter du 13 décembre', 'tp')).toBe('tp');
  });

  it('declares every feed with a known canton group and an https URL', () => {
    const groups = new Set(Object.keys(cantonUrlSlugs.cantons));
    const ids = new Set<string>();
    for (const f of ROAD_EVENT_FEEDS) {
      expect(groups.has(f.canton), f.id).toBe(true);
      expect(f.url).toMatch(/^https:\/\//);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
    }
  });
});

describe('road events — payload gate', () => {
  const knownCantons = new Set(Object.keys(cantonUrlSlugs.cantons));
  const ok = {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    sources: [{ id: 'fr-police', status: 'ok', count: 1 }],
    events: [{ id: 'x', canton: 'FR', type: 'chiusura', title: 't', url: 'https://www.fr.ch/a', validFrom: null, validTo: null, publishedAt: NOW.toISOString(), source: 'fr-police', observedAt: NOW.toISOString() }],
  };

  it('accepts a well-formed payload', () => {
    expect(validateRoadEventsPayload(ok, { knownCantons })).toEqual([]);
  });

  it('rejects a BFS half-canton code, an unknown type and a non-https url', () => {
    const bad = { ...ok, events: [{ ...ok.events[0], canton: 'BS', type: 'other', url: 'http://x' }] };
    expect(validateRoadEventsPayload(bad, { knownCantons })).toEqual(
      expect.arrayContaining([expect.stringContaining('canton BS'), expect.stringContaining('type other'), expect.stringContaining('url http://x')]),
    );
  });

  it('merges the two directions of one closure into one record', () => {
    const a = { ...ok.events[0], id: 'a', validFrom: '2026-10-01T00:00:00.000Z', validTo: '2026-10-03T00:00:00.000Z' };
    const b = { ...ok.events[0], id: 'b', validFrom: '2026-09-30T00:00:00.000Z', validTo: '2026-10-02T00:00:00.000Z' };
    expect(dedupeRoadEvents([a, b])).toEqual([{ ...a, validFrom: '2026-09-30T00:00:00.000Z' }]);
  });
});

describe('road events — carry-forward of a failing source', () => {
  const ev = (source: string) => ({ id: `${source}:1`, canton: 'FR', type: 'traffico', title: 't', url: 'https://x.ch/a', validFrom: null, validTo: null, publishedAt: null, source, observedAt: '2026-10-04T00:00:00.000Z' });

  it('carries a failing source only while ITS last success is recent, whatever its siblings do', () => {
    const t0 = Date.parse('2026-10-04T00:00:00Z');
    // Hour 0: both ok.
    let previous: any = { sources: [], events: [] };
    const run = (hour: number, aOk: boolean) => {
      const now = new Date(t0 + hour * 3_600_000);
      const results: any[] = [
        { id: 'a', status: aOk ? 'ok' : 'error', events: aOk ? [ev('a')] : [] },
        { id: 'b', status: 'ok', events: [ev('b')] },
      ];
      const carried = carryForwardFailedSources(results, previous, { now, maxHours: 24 });
      const events = [...results.flatMap((r) => r.events), ...carried];
      previous = { sources: results.map(({ events: _e, ...rest }) => rest), events };
      return events.filter((e) => e.source === 'a').length;
    };
    expect(run(0, true)).toBe(1);
    // Source A down from hour 3 on, B healthy every 3 hours.
    for (let h = 3; h <= 24; h += 3) expect(run(h, false), `hour ${h}`).toBe(1);
    expect(run(27, false)).toBe(0);
    expect(previous.sources.find((s: any) => s.id === 'a').lastSuccessAt).toBe('2026-10-04T00:00:00.000Z');
  });
});
