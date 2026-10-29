/**
 * Generator-side coverage for the Swiss diesel-cheapest selection in
 * `scripts/generate-fuel-prices-dataset.mjs`.
 *
 * `cheapestStation`/`nearbyStations` are ranked + truncated by sp95 (benzina).
 * For an accurate diesel verdict the generator ranks the FULL candidate set by
 * diesel and persists `cheapestDieselStation` separately, because the genuinely
 * diesel-cheapest pump can fall outside the sp95 top-5 — or the sp95-cheapest
 * pump may carry no diesel price at all.
 *
 * The consumer side (`collectCityCrossBorder`) is already covered with a
 * hand-crafted dataset in `fuel-diesel-italy.test.ts`; that never exercises the
 * generator's reduce. This test drives the real generator functions so a
 * regression there (e.g. picking the sp95 min, the max, or mishandling
 * null-diesel stations) fails loudly instead of shipping silently.
 */

import { describe, expect, it } from 'vitest';
import {
  buildItalyStations,
  buildDataset,
  buildSwissCoverageDiagnostics,
  buildSwissBorderStations,
  extractEcbRate,
  fetchSwissStations,
  fetchSwissStationsByFuel,
  chunkSwissNationalStations,
  chunkSwissBorderMunicipalities,
  SWISS_TCS_BBOX,
} from '../scripts/generate-fuel-prices-dataset.mjs';

const COMO = { name: 'Como', province: 'CO', lat: 45.81, lng: 9.08, distanceKm: 0, fascia: '0-10' };

// All stations sit on Como's coordinates (distance ≈ 0, well inside the 20 km
// search radius). Prices are in CHF; with eurPerChf = 1 the EUR mirrors them.
// `G` is the sp95-cheapest pump but has NO diesel price; `F` is the most
// expensive on sp95 yet carries the genuinely cheapest diesel. So the diesel
// verdict must pick `F`, never `G` (the sp95 winner) nor the sp95 top-5 min.
function rawStation(id: string, sp95PriceChf: number, dieselPriceChf: number | null) {
  return { id, name: id, brand: id, address: 'Chiasso', lat: 45.81, lng: 9.08, sp95PriceChf, dieselPriceChf };
}

function runGenerator(rawStations: ReturnType<typeof rawStation>[]) {
  const swissStations = buildSwissBorderStations([COMO], rawStations, 1);
  const payload = buildDataset({
    municipalities: [COMO],
    italyExtractedAt: '2026-06-01',
    swissStations,
    italyByMunicipality: new Map(),
    exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
  });
  return payload.municipalities[0].swiss;
}

describe('generate-fuel-prices-dataset diesel ranking', () => {
  it('chunks the border comparator independently from the national station feed', () => {
    const rows = Array.from({ length: 123 }, (_, index) => ({
      municipality: `M${index}`,
      province: 'CO',
      swiss: { optionCount: 1 },
    }));

    expect(chunkSwissBorderMunicipalities(rows, 50).map((chunk) => chunk.length)).toEqual([50, 50, 23]);
    expect(chunkSwissBorderMunicipalities([], 50)).toEqual([]);
    expect(() => chunkSwissBorderMunicipalities(rows, 0)).toThrow('Swiss border chunk size must be a positive integer');
  });

  it('extracts and validates the ECB reference date with the CHF rate', () => {
    const rate = extractEcbRate('<Envelope><Cube time="2026-06-01"><Cube currency="CHF" rate="0.95"/></Cube></Envelope>');

    expect(rate).toEqual({ rateDate: '2026-06-01', chfPerEur: 0.95, eurPerChf: 1 / 0.95 });
    expect(() => extractEcbRate('<Envelope><Cube><Cube currency="CHF" rate="0.95"/></Cube></Envelope>'))
      .toThrow('ECB reference date not found');
    expect(() => extractEcbRate('<Envelope><Cube time="2026-02-30"><Cube currency="CHF" rate="0.95"/></Cube></Envelope>'))
      .toThrow('Invalid ECB reference date');
    expect(() => extractEcbRate('<Envelope><Cube time="2026-06-01"><Cube currency="CHF" rate="0"/></Cube></Envelope>'))
      .toThrow('Invalid ECB CHF rate');
  });

  it('persists the ECB reference date in the published dataset source metadata', () => {
    const payload = buildDataset({
      municipalities: [],
      italyExtractedAt: '2026-06-01',
      swissStations: [],
      italyByMunicipality: new Map(),
      exchangeRate: { rateDate: '2026-06-01', chfPerEur: 0.95, eurPerChf: 1 / 0.95 },
    });

    expect(payload.sources.exchangeRate).toMatchObject({ provider: 'ECB', rateDate: '2026-06-01' });
  });

  it('persists the full-set diesel minimum, not the sp95-cheapest pump', () => {
    const swiss = runGenerator([
      rawStation('G', 1.98, null), // sp95-cheapest, but no diesel price
      rawStation('A', 2.0, 2.3),
      rawStation('B', 2.05, 2.25),
      rawStation('C', 2.1, 2.2),
      rawStation('D', 2.15, 2.1), // sp95 top-5 diesel min — must NOT win
      rawStation('E', 2.18, 1.95),
      rawStation('F', 2.3, 1.8), // global diesel min, outside sp95 top-5
    ]);

    // The sp95 verdict still points at G (the benzina-cheapest pump)…
    expect(swiss.cheapestStation.id).toBe('G');
    expect(swiss.cheapestStation.dieselPriceEur).toBeNull();

    // …but the diesel verdict is the genuine full-set diesel minimum (F),
    // distinct from both the sp95 winner and the sp95 top-5 diesel min (D).
    expect(swiss.cheapestDieselStation.id).toBe('F');
    expect(swiss.cheapestDieselStation.id).not.toBe(swiss.cheapestStation.id);
    expect(swiss.minDieselPriceEur).toBe(1.8);
    expect(swiss.minDieselPriceChf).toBe(1.8);
    expect(swiss.dieselOptionCount).toBe(6);
  });

  it('yields a null diesel verdict when no candidate has a diesel price', () => {
    const swiss = runGenerator([
      rawStation('A', 2.0, null),
      rawStation('B', 2.1, null),
    ]);

    expect(swiss.cheapestStation.id).toBe('A');
    expect(swiss.cheapestDieselStation).toBeNull();
    expect(swiss.minDieselPriceEur).toBeNull();
    expect(swiss.minDieselPriceChf).toBeNull();
    expect(swiss.dieselOptionCount).toBe(0);
  });

  it('keeps the MIMIT benzina and diesel observation dates separate', () => {
    const italyByMunicipality = buildItalyStations(
      [COMO],
      [{
        idImpianto: 'station-1', Comune: 'Como', Provincia: 'CO',
        'Nome Impianto': 'Station 1', Bandiera: 'Test', Indirizzo: 'Via Roma 1',
        Latitudine: '45.81', Longitudine: '9.08',
      }],
      [
        { idImpianto: 'station-1', descCarburante: 'Benzina', prezzo: '1.80', isSelf: '1', dtComu: '09/10/2026 18:21:14' },
        { idImpianto: 'station-1', descCarburante: 'Gasolio', prezzo: '1.70', isSelf: '1', dtComu: '08/10/2026 10:00:00' },
      ],
    );
    const payload = buildDataset({
      municipalities: [COMO],
      italyExtractedAt: '2026-10-10',
      swissStations: [],
      italyByMunicipality,
      exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
    });
    const station = payload.municipalities[0].italy.stations[0];

    expect(station).toMatchObject({
      benzinaUpdatedAt: '2026-10-09',
      dieselUpdatedAt: '2026-10-08',
      // Retain the historic ambiguous field for older consumers.
      updatedAt: '08/10/2026 10:00:00',
    });
  });

  it('rejects invalid or non-contract MIMIT date strings while accepting explicit ISO timestamps', () => {
    const stationIds = ['bad-day', 'bad-time', 'ambiguous', 'iso'];
    const stationRows = stationIds.map((id) => ({
      idImpianto: id, Comune: 'Como', Provincia: 'CO',
      'Nome Impianto': id, Bandiera: 'Test', Indirizzo: 'Via Roma 1',
      Latitudine: '45.81', Longitudine: '9.08',
    }));
    const timestamps = [
      '31/02/2026 12:00:00',
      '12/10/2026 25:61:00',
      '10-12-2026',
      '2026-10-12T08:30:00+02:00',
    ];
    const italyByMunicipality = buildItalyStations(
      [COMO],
      stationRows,
      stationIds.map((id, index) => ({
        idImpianto: id, descCarburante: 'Benzina', prezzo: '1.80', isSelf: '1', dtComu: timestamps[index],
      })),
    );
    const stations = italyByMunicipality.get('Como:CO')! as Array<{ id: string; benzinaUpdatedAt: string | null }>;
    const byId = new Map<string, typeof stations[number]>(stations.map((station) => [station.id, station]));

    expect(byId.get('bad-day')?.benzinaUpdatedAt).toBeNull();
    expect(byId.get('bad-time')?.benzinaUpdatedAt).toBeNull();
    expect(byId.get('ambiguous')?.benzinaUpdatedAt).toBeNull();
    expect(byId.get('iso')?.benzinaUpdatedAt).toBe('2026-10-12T06:30:00.000Z');
  });
});

describe('generate-fuel-prices-dataset national Swiss ingestion', () => {
  it('uses the verified national TCS envelope rather than the truncated border bbox', async () => {
    expect(SWISS_TCS_BBOX).toEqual([5.8, 45.7, 10.7, 47.9]);
    expect(SWISS_TCS_BBOX[0]).toBeLessThanOrEqual(5.8);
    expect(SWISS_TCS_BBOX[3]).toBeGreaterThanOrEqual(47.9);

    let requestedBbox: number[] | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { bbox: number[] };
      requestedBbox = body.bbox;
      return { ok: true, status: 200, json: async () => [] } as Response;
    }) as any;
    await fetchSwissStationsByFuel('SP95', { fetchImpl, retries: 1 });

    expect(requestedBbox).toEqual([5.8, 45.7, 10.7, 47.9]);
  });

  it('keeps the national snapshot separate from the border comparator projection', () => {
    const nationalStations = [
      rawStation('border', 1.8, 1.9),
      {
        ...rawStation('national-only', 2.0, null),
        address: 'Zürichstrasse 1, Zürich',
        lat: 47.38,
        lng: 8.54,
      },
    ];
    const borderStations = buildSwissBorderStations([COMO], nationalStations, 1);
    const coverage = buildSwissCoverageDiagnostics(nationalStations, {
      resolveStationCanton: () => 'TI',
      expectedCantons: ['TI'],
      inputStationCount: nationalStations.length,
      observedAt: '2026-10-29T12:00:00.000Z',
    });
    const payload = buildDataset({
      municipalities: [COMO],
      italyExtractedAt: '2026-10-29',
      swissStations: borderStations,
      nationalSwissStations: nationalStations,
      swissCoverage: coverage,
      italyByMunicipality: new Map(),
      exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
    });

    expect(borderStations).toHaveLength(1);
    expect(payload.municipalities[0].swiss.optionCount).toBe(1);
    expect(payload.sources.switzerland.stationCount).toBe(1);
    expect(payload.sources.switzerland.nationalStationCount).toBe(2);
    expect(payload.summary.swissBorderStationCount).toBe(1);
    expect(payload.summary.swissNationalStationCount).toBe(2);
    expect(payload.national).toMatchObject({
      scope: 'national',
      country: 'CH',
      coverageType: 'provider-snapshot',
      inventoryCompleteness: 'not-verified',
      anchorFuel: 'SP95',
      stationCount: 2,
      observedAt: '2026-10-29T12:00:00.000Z',
    });
    expect(payload.national.stations.map((station) => station.id)).toEqual(['border', 'national-only']);
  });

  it('keeps the comparator projection bounded to 25 km from the frontier municipalities', () => {
    const within25Km = { ...rawStation('within-25km', 1.85, 1.95), lat: 46.0, lng: 9.08 };
    const beyond25Km = { ...rawStation('beyond-25km', 1.86, 1.96), lat: 46.05, lng: 9.08 };
    const projection = buildSwissBorderStations([COMO], [within25Km, beyond25Km], 1);

    expect(projection.map((station) => station.id)).toEqual(['within-25km']);
  });

  it('reports canton/area coverage and partial diesel without counting null as zero', () => {
    const stations = [
      rawStation('ti', 1.8, 1.9),
      { ...rawStation('zh', 1.9, null), address: 'Zürichstrasse 1, Zürich' },
      { ...rawStation('unknown', 2.0, null), address: 'Unknown address' },
    ];
    const coverage = buildSwissCoverageDiagnostics(stations, {
      resolveStationCanton: (station) => ({ ti: 'TI', zh: 'ZH' }[station.id] ?? null),
      expectedCantons: ['TI', 'ZH', 'GE'],
      inputStationCount: 4,
      duplicateCount: 1,
      observedAt: '2026-10-29T12:00:00.000Z',
    });

    expect(coverage).toMatchObject({
      inputStationCount: 4,
      uniqueStationCount: 3,
      duplicateCount: 1,
      resolvedStationCount: 2,
      unresolvedStationCount: 1,
      resolution: {
        status: 'partial',
        expectedCantonCount: 3,
        coveredCantonCount: 2,
      },
      fuelCoverage: {
        benzina: { stationCount: 3, missingPriceCount: 0, coveragePct: 100 },
        diesel: { stationCount: 1, missingPriceCount: 2, coveragePct: 33.3 },
      },
      byArea: { CH: { stations: 3, benzina: 3, diesel: 1, dieselCoveragePct: 33.3 } },
    });
    expect(coverage.byCanton).toMatchObject({
      TI: { stations: 1, benzina: 1, diesel: 1, dieselCoveragePct: 100 },
      ZH: { stations: 1, benzina: 1, diesel: 0, dieselCoveragePct: 0 },
      GE: { stations: 0, benzina: 0, diesel: 0, dieselCoveragePct: 0 },
    });
  });

  it('keeps SP95 mandatory while tolerating a failed diesel provider call', async () => {
    const calls: Array<{ fuel: string; bbox: number[] }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { filters: { fuel: string }; bbox: number[] };
      calls.push({ fuel: body.filters.fuel, bbox: body.bbox });
      if (body.filters.fuel === 'DIESEL') throw new Error('diesel endpoint unavailable');
      return {
        ok: true,
        status: 200,
        json: async () => [{
          id: 'tcs-1',
          displayName: 'Test Station',
          brand: 'Test',
          formattedAddress: 'Via Roma 1, Lugano',
          latitude: 46.0,
          longitude: 8.95,
          price: 1.8,
          fiability: 'CONFIDENT',
        }],
      } as Response;
    }) as any;

    const stations = await fetchSwissStations({
      fetchImpl,
      retries: 1,
      now: new Date('2026-10-29T12:00:00.000Z'),
    });

    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      id: 'tcs-1',
      sp95PriceChf: 1.8,
      dieselPriceChf: null,
      observedAt: '2026-10-29T12:00:00.000Z',
      updatedAt: null,
      dieselUpdatedAt: null,
      source: 'tcs-benzinpreis-cloud-function',
    });
    expect(calls.map((call) => call.fuel).sort()).toEqual(['DIESEL', 'SP95']);
    expect(calls.every((call) => call.bbox.join(',') === '5.8,45.7,10.7,47.9')).toBe(true);
  });

  it('unions SP95 and DIESEL station ids while keeping fuel status and fiability separate', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { filters: { fuel: string } };
      const common = {
        id: 'shared',
        displayName: 'Shared Station',
        brand: 'TCS Test',
        formattedAddress: 'Via Roma 1, 6830 Chiasso',
        latitude: 45.84,
        longitude: 9.02,
      };
      if (body.filters.fuel === 'SP95') {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { ...common, price: 1.8, fiability: 'SP95_CONFIDENT' },
            { ...common, id: 'only-sp95', displayName: 'SP95 Only', price: 1.82, fiability: 'SP95_REPORTED' },
          ],
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          { ...common, price: 1.9, fiability: 'DIESEL_CONFIDENT' },
          { ...common, id: 'only-diesel', displayName: 'Diesel Only', price: 1.91, fiability: 'DIESEL_REPORTED' },
        ],
      } as Response;
    }) as any;

    const stations = await fetchSwissStations({
      fetchImpl,
      retries: 1,
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    const byId = new Map(stations.map((station) => [station.id, station]));

    expect([...byId.keys()].sort()).toEqual(['only-diesel', 'only-sp95', 'shared']);
    expect(byId.get('only-diesel')).toMatchObject({
      sp95PriceChf: null,
      dieselPriceChf: 1.91,
      priceStatus: { sp95: 'unavailable', diesel: 'available' },
      sp95SourceQuality: null,
      dieselSourceQuality: 'DIESEL_REPORTED',
      observedAt: '2026-10-29T12:00:00.000Z',
      updatedAt: null,
      dieselUpdatedAt: null,
    });
    expect(byId.get('only-sp95')).toMatchObject({
      sp95PriceChf: 1.82,
      dieselPriceChf: null,
      priceStatus: { sp95: 'available', diesel: 'unavailable' },
      sp95SourceQuality: 'SP95_REPORTED',
      dieselSourceQuality: null,
      dieselUpdatedAt: null,
    });
    expect(byId.get('shared')).toMatchObject({
      sp95SourceQuality: 'SP95_CONFIDENT',
      dieselSourceQuality: 'DIESEL_CONFIDENT',
      sourceQuality: 'SP95_CONFIDENT',
    });
    expect(byId.get('shared')?.sourceObservedAt).toBeUndefined();

    // The national union keeps all three; the historical benzina projection
    // remains SP95-backed and therefore excludes the DIESEL-only row.
    const comparator = buildSwissBorderStations([{ ...COMO, lat: 45.84, lng: 9.02 }], stations, 1);
    expect(comparator.map((station) => station.id).sort()).toEqual(['only-sp95', 'shared']);
  });

  it('fails safe when the mandatory SP95 snapshot has no usable rows', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)) as any;

    await expect(fetchSwissStations({ fetchImpl, retries: 1 })).rejects.toThrow(
      'TCS SP95 returned no usable national station rows',
    );
  });
});
