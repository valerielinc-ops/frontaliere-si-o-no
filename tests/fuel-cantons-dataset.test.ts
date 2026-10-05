import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import {
  AT_REGIONS_BY_CANTON,
  FR_DEPARTMENTS_BY_CANTON,
  MIN_STATIONS_PER_RECORD,
  buildAtRecords,
  buildChRecords,
  buildFrRecords,
  buildFuelCantonsDataset,
  buildItRecords,
  createStationCantonResolver,
  expectedCantons,
  extractSingleZipEntry,
  parseEControStations,
  parseFrenchInstantXml,
  parseFrenchTimestamp,
  parseItalianTimestamp,
  parseTankerkoenigStations,
  summarizePrices,
  validateFuelCantonsDataset,
} from '../scripts/lib/fuel-cantons-dataset.mjs';
import {
  fetchAustrianStations,
  fetchFrenchStations,
  fetchGermanStations,
} from '../scripts/lib/fuel-foreign-sources.mjs';
import { buildFromInput } from '../scripts/build-fuel-cantons-dataset.mjs';
import { buildFuelCantonsInput } from '../scripts/generate-fuel-prices-dataset.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const cantonSlugFile = readJson('data/canton-url-slugs.json');
const postalIndex = readJson('data/swiss-postal-code-index.json');
const localityIndex = readJson('data/swiss-locality-postal-codes.json');
const CANTONS = Object.keys(cantonSlugFile.cantons);

const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
// French feed timestamps are Europe/Paris wall-clock "YYYY-MM-DD HH:MM:SS".
const parisWallClock = (d: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(d);
// MIMIT timestamps are Europe/Rome "DD/MM/YYYY HH:MM:SS".
const romeWallClock = (d: Date) => {
  const [date, time] = parisWallClock(d).split(' ');
  const [y, m, day] = date.split('-');
  return `${day}/${m}/${y} ${time}`;
};

function makeZip(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, cd, nameBuf, eocd]);
}

function frenchPdv(id: string, cp: string, prices: Array<[string, number, Date]>) {
  const rows = prices
    .map(([nom, valeur, at]) => `<prix nom="${nom}" id="1" maj="${parisWallClock(at)}" valeur="${valeur}"/>`)
    .join('\n');
  return `<pdv id="${id}" latitude="4700000" longitude="600000" cp="${cp}" pop="R"><adresse>x</adresse>${rows}</pdv>`;
}

function frenchXml(pdvs: string[]) {
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<pdv_liste>\n${pdvs.join('\n')}\n</pdv_liste>`;
}

describe('fuel cantons — source parsers', () => {
  it('extracts the single deflated entry of a zip archive', () => {
    const xml = Buffer.from(frenchXml([frenchPdv('25000001', '25000', [['Gazole', 2.1, hoursAgo(1)]])]));
    expect(extractSingleZipEntry(makeZip('PrixCarburants_instantane.xml', xml), inflateRawSync).equals(xml)).toBe(true);
    expect(() => extractSingleZipEntry(Buffer.from('not a zip at all, definitely not'), inflateRawSync)).toThrow(/central directory/);
  });

  it('keeps only the configured départements and maps SP95/E10/Gazole', () => {
    const at = hoursAgo(2);
    const xml = frenchXml([
      frenchPdv('74000001', '74000', [['SP95', 2.2, at], ['E10', 2.1, at], ['Gazole', 2.3, at]]),
      frenchPdv('01210001', '01210', [['E10', 2.05, at]]),
      // Pre-2022 feeds: thousandths of a euro.
      frenchPdv('25300001', '25300', [['Gazole', 2310, at]]),
      frenchPdv('75001001', '75001', [['SP95', 2.5, at]]),
      frenchPdv('68000001', '68000', [['GPLc', 1.1, at]]),
    ]);
    const stations = parseFrenchInstantXml(xml, { departments: ['74', '01', '25', '68'] });
    expect(stations.map((s: any) => s.id)).toEqual(['FR-74000001', 'FR-01210001', 'FR-25300001']);
    expect(stations[0].sp95.price).toBe(2.2);
    expect(stations[1].sp95.price).toBe(2.05);
    expect(stations[1].diesel).toBeNull();
    expect(stations[2].diesel.price).toBeCloseTo(2.31, 6);
    expect(Date.parse(stations[0].sp95.observedAt)).toBe(Math.floor(at.getTime() / 1000) * 1000);
  });

  it('converts Paris and Rome wall-clock times across DST', () => {
    expect(parseFrenchTimestamp('2026-07-01 12:00:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(parseFrenchTimestamp('2026-01-15 12:00:00')).toBe('2026-01-15T11:00:00.000Z');
    expect(parseItalianTimestamp('01/10/2026 07:54:22')).toBe('2026-10-01T05:54:22.000Z');
    expect(parseFrenchTimestamp('garbage')).toBeNull();
  });

  it('parses E-Control and Tankerkönig responses', () => {
    expect(parseEControStations([
      { id: 1, prices: [{ fuelType: 'DIE', amount: 2.077 }] },
      { id: 2, prices: [] },
    ])).toEqual([{ id: 'AT-1', price: 2.077 }]);
    expect(() => parseEControStations({ error: 'x' })).toThrow();
    expect(parseTankerkoenigStations({ ok: true, stations: [{ id: 'a', e5: 1.9, diesel: false }] }))
      .toEqual([{ id: 'DE-a', sp95: 1.9, diesel: null }]);
    expect(() => parseTankerkoenigStations({ ok: false, message: 'apikey nicht angegeben' })).toThrow(/apikey/);
  });
});

describe('fuel cantons — canton resolution of Swiss stations', () => {
  const resolve = createStationCantonResolver({ postalIndex, localityIndex, cantonSlugFile });

  it('resolves the NPA to the URL group and never defaults', () => {
    expect(resolve({ address: 'Via Emilio Bossi 6, 6830 Chiasso' })).toBe('TI');
    expect(resolve({ address: 'Hauptgasse 1, 9050 Appenzell' })).toBe('APPENZELLO');
    expect(resolve({ address: 'Steinenvorstadt 2, 4051 Basel' })).toBe('BASILEA');
    // A four-digit house number before the real NPA must not win.
    expect(resolve({ address: 'Route 1200, 1950 Sion' })).toBe('VS');
    // NPA shared by several localities of one canton (left out of the
    // single-locality index) still resolves through the locality directory.
    expect(resolve({ address: 'Via Cantonale 1, 6900 Lugano' })).toBe('TI');
    // No NPA at all: the trailing locality name, when unambiguous.
    expect(resolve({ address: 'Bahnhofstrasse 3, Chur' })).toBe('GR');
    expect(resolve({ address: 'Somewhere without postcode' })).toBeNull();
  });
});

describe('fuel cantons — aggregation', () => {
  it('dedupes by id, drops implausible prices and outliers, enforces the station floor', () => {
    const obs = [
      { id: 'a', price: 2.0, observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'a', price: 2.0, observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', price: 2.1, observedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'c', price: 1.9 },
      { id: 'd', price: 1.2 }, // > 20% below the median: stale/mistyped row
      { id: 'e', price: 19.9 }, // outside PRICE_BOUNDS
    ];
    const r = summarizePrices({ canton: 'TI', side: 'IT', fuel: 'sp95', currency: 'EUR', observations: obs, source: 's', area: 'a', coverage: 'c' });
    expect(r).toMatchObject({ canton: 'TI', side: 'IT', fuel: 'sp95', avg: 2, median: 2, min: 1.9, stations: 3, observedAt: '2026-01-02T00:00:00.000Z' });
    expect(summarizePrices({ canton: 'TI', side: 'IT', fuel: 'sp95', currency: 'EUR', observations: obs.slice(0, MIN_STATIONS_PER_RECORD - 1), source: 's' })).toBeNull();
  });

  it('builds CH records per resolved canton and IT records from self-service rows only', () => {
    const resolve = createStationCantonResolver({ postalIndex, localityIndex, cantonSlugFile });
    const swissStations = [1, 2, 3].map((i) => ({ id: `t${i}`, address: `Via ${i}, 6900 Lugano`, sp95PriceChf: 1.9 + i / 100, dieselPriceChf: 2 + i / 100, updatedAt: hoursAgo(1).toISOString() }));
    swissStations.push({ id: 'x', address: 'no npa', sp95PriceChf: 1.9, dieselPriceChf: 2, updatedAt: null as any });
    const ch = buildChRecords({ swissStations, resolveStationCanton: resolve, observedAtFallback: 'fallback' });
    expect(ch.map((r: any) => `${r.canton}/${r.side}/${r.fuel}/${r.stations}`)).toEqual(['TI/CH/sp95/3', 'TI/CH/diesel/3']);

    const fresh = romeWallClock(hoursAgo(5));
    const stale = romeWallClock(hoursAgo(24 * 40));
    const italyStations = [
      ...[1, 2, 3].map((i) => ({ id: `co${i}`, province: 'CO', isSelf: true, priceEur: 1.95, dieselPriceEur: 2.05, updatedAt: fresh })),
      { id: 'co9', province: 'CO', isSelf: false, priceEur: 2.2, dieselPriceEur: 2.3, updatedAt: fresh },
      { id: 'co8', province: 'CO', isSelf: true, priceEur: 1.95, dieselPriceEur: 2.05, updatedAt: stale },
    ];
    const it = buildItRecords({ italyStations, nowMs: Date.now() });
    expect(it.filter((r: any) => r.canton === 'TI').map((r: any) => r.stations)).toEqual([3, 3]);
  });
});

function syntheticRecords() {
  const nowIso = new Date().toISOString();
  const frenchStations = Object.values(FR_DEPARTMENTS_BY_CANTON).flat().flatMap((dep, i) =>
    [0, 1, 2].map((k) => ({ id: `FR-${dep}-${k}`, department: dep, sp95: { price: 2.2 + k / 100, observedAt: nowIso }, diesel: { price: 2.4, observedAt: nowIso } })));
  const austrianByRegion = Object.fromEntries([...new Set(Object.values(AT_REGIONS_BY_CANTON).flat())].map((code) => [code, {
    sp95: [0, 1, 2].map((k) => ({ id: `AT-${code}-${k}`, price: 1.8 })),
    diesel: [0, 1, 2].map((k) => ({ id: `AT-${code}-${k}`, price: 2.1 })),
  }]));
  const resolve = createStationCantonResolver({ postalIndex, localityIndex, cantonSlugFile });
  const swissStations = [['6900 Lugano', 3], ['7500 St. Moritz', 3], ['3900 Brig', 3]].flatMap(([addr, n]) =>
    Array.from({ length: n as number }, (_, k) => ({ id: `${addr}-${k}`, address: `Strasse ${k}, ${addr}`, sp95PriceChf: 2, dieselPriceChf: 2.2, updatedAt: nowIso })));
  const fresh = romeWallClock(hoursAgo(3));
  const italyStations = ['CO', 'SO', 'VB'].flatMap((p) => [0, 1, 2].map((k) => ({ id: `${p}${k}`, province: p, isSelf: true, priceEur: 1.95, dieselPriceEur: 2.05, updatedAt: fresh })));
  return {
    ch: buildChRecords({ swissStations, resolveStationCanton: resolve }),
    it: buildItRecords({ italyStations, nowMs: Date.now() }),
    fr: buildFrRecords({ frenchStations, nowMs: Date.now() }),
    at: buildAtRecords({ austrianByRegion, observedAt: nowIso }),
  };
}

describe('fuel cantons — dataset and validity gate', () => {
  it('publishes one flat record per canton/side/fuel with the contract fields', () => {
    const { ch, it, fr, at } = syntheticRecords();
    const dataset = buildFuelCantonsDataset({ cantonCodes: CANTONS, generatedAt: new Date().toISOString(), exchangeRate: { chfPerEur: 0.93, eurPerChf: 1.075 }, sourceStatus: {}, records: [...fr, ...ch, ...at, ...it] });
    expect(dataset.cantons).toHaveLength(24);
    expect(dataset.coverage.expectedCantonsWithData).toEqual(expectedCantons());
    for (const r of dataset.records) {
      for (const key of ['canton', 'side', 'fuel', 'avg', 'min', 'stations', 'observedAt', 'source']) expect(r).toHaveProperty(key);
      expect(CANTONS).toContain(r.canton);
    }
    expect(dataset.records[0].canton <= dataset.records[dataset.records.length - 1].canton).toBe(true);
    expect(validateFuelCantonsDataset(dataset)).toMatchObject({ ok: true, coverageRatio: 1 });
  });

  it('refuses the dataset when the French feed is lost (too many expected cantons empty)', () => {
    const { ch, it, at } = syntheticRecords();
    const dataset = buildFuelCantonsDataset({ cantonCodes: CANTONS, generatedAt: new Date().toISOString(), exchangeRate: null, sourceStatus: {}, records: [...ch, ...it, ...at] });
    const verdict = validateFuelCantonsDataset(dataset);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/expected cantons have data/);
  });

  it('refuses the dataset when the Swiss/Italian generator input is missing', () => {
    const { fr, at } = syntheticRecords();
    const dataset = buildFuelCantonsDataset({ cantonCodes: CANTONS, generatedAt: new Date().toISOString(), exchangeRate: null, sourceStatus: {}, records: [...fr, ...at] });
    expect(validateFuelCantonsDataset(dataset).errors).toEqual(expect.arrayContaining([expect.stringMatching(/no CH record/), expect.stringMatching(/no IT record/)]));
  });

  it('rejects a configured canton that is not a URL group', () => {
    expect(() => buildFuelCantonsDataset({ cantonCodes: CANTONS.filter((c) => c !== 'GE'), generatedAt: '', exchangeRate: null, sourceStatus: {}, records: [] })).toThrow(/GE/);
  });
});

describe('fuel cantons — fetchers are failure-isolated', () => {
  const okResponse = (body: unknown, binary = false) => ({
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => {
      const b = body as Buffer;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    binary,
  });

  it('skips Germany without the Tankerkönig key and never leaks the key in a failure', async () => {
    expect(await fetchGermanStations({ apiKey: '' })).toMatchObject({ status: 'skipped' });
    const secret = 'k3y-should-not-leak';
    const res = await fetchGermanStations({
      apiKey: secret,
      retries: 1,
      fetchImpl: (async (url: string) => { throw new Error(`boom ${url}`); }) as any,
    });
    expect(res.status).toBe('failed');
    expect(res.reason).not.toContain(secret);
  });

  it('reads the Austrian regions and the French zip through the injected fetch', async () => {
    const at = await fetchAustrianStations({ fetchImpl: (async () => okResponse([{ id: 7, prices: [{ amount: 2.0 }] }])) as any });
    expect(at.status).toBe('ok');
    expect(at.data[8].sp95).toEqual([{ id: 'AT-7', price: 2 }]);

    const zip = makeZip('x.xml', Buffer.from(frenchXml([frenchPdv('74000001', '74000', [['Gazole', 2.3, hoursAgo(1)]])]), 'latin1'));
    const fr = await fetchFrenchStations({ fetchImpl: (async () => okResponse(zip, true)) as any });
    expect(fr).toMatchObject({ status: 'ok', stationCount: 1 });
  });
});

describe('fuel cantons — producer CLI', () => {
  it('builds from the generator hand-off with injected foreign sources', async () => {
    const nowIso = new Date().toISOString();
    const italyByMunicipality = new Map([
      ['Como:CO', [0, 1, 2].map((k) => ({ id: `c${k}`, isSelf: true, priceEur: 1.95, dieselPriceEur: 2.05, updatedAt: romeWallClock(hoursAgo(2)) }))],
    ]);
    const input = buildFuelCantonsInput({
      generatedAt: nowIso,
      italyExtractedAt: nowIso.slice(0, 10),
      swissStations: [0, 1, 2].map((k) => ({ id: `s${k}`, address: `Via ${k}, 6900 Lugano`, lat: 46, lng: 8.95, sp95PriceChf: 1.99, dieselPriceChf: 2.1, updatedAt: nowIso, name: 'drop me' })),
      italyByMunicipality,
      exchangeRate: { chfPerEur: 0.93, eurPerChf: 1.075 },
    });
    expect(input.italyStations[0]).toMatchObject({ province: 'CO', isSelf: true });
    expect(input.swissStations[0]).not.toHaveProperty('name');

    const dataset = await buildFromInput(input, {
      fetchers: {
        fr: async () => ({ status: 'failed', reason: 'offline', data: [] }),
        at: async () => ({ status: 'ok', data: { 8: { sp95: [], diesel: [] }, 7: { sp95: [], diesel: [] } } }),
        de: async () => ({ status: 'skipped', reason: 'no key', data: {} }),
      },
    });
    expect(dataset.sources.FR).toMatchObject({ status: 'failed', reason: 'offline' });
    expect(dataset.sources.FR).not.toHaveProperty('data');
    expect(dataset.records.filter((r: any) => r.canton === 'TI').map((r: any) => r.side)).toEqual(['CH', 'CH', 'IT', 'IT']);
    expect(validateFuelCantonsDataset(dataset).ok).toBe(false);
  });

  it('exits 0 and writes nothing when the generator skipped its run', () => {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-cantons-'));
    const res = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-fuel-cantons-dataset.mjs'),
      '--input', path.join(outRoot, 'missing.json'),
      '--out-root', outRoot,
    ], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not found/);
    expect(fs.existsSync(path.join(outRoot, 'data'))).toBe(false);
  });
});
