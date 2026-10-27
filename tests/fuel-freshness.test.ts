/**
 * Freshness of the fuel "oggi" pages.
 *
 * 2026-10-17..23: MIMIT stopped answering the runners, the generator bailed
 * out on the shared Promise.all and threw away the (reachable) TCS prices too,
 * so every /prezzi-*\/oggi/ title kept «TCS 16.10.2026» for a week while the
 * workflow stayed green. These tests pin the three pieces of the fix:
 *  1. an Italian outage degrades the Italian half only (carry-over, dated);
 *  2. Italian/CH station titles carry the observation day, not the build day;
 *  3. a freshness gate fails when a source is older than 48h.
 * All dates are relative to the test clock (no calendar time bombs).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildItalyRowsFromMimitApi,
  buildDataset,
  buildItalyStations,
  fetchMimitApiSource,
  italyByMunicipalityFromDataset,
  resolveItalySource,
  validateMimitCsvPayload,
} from '../scripts/generate-fuel-prices-dataset.mjs';
import { evaluateFuelFreshness } from '../scripts/check-fuel-freshness.mjs';
import {
  generateFuelItalianCityPages,
  isFuelObservationStale,
  latestItalianObservationDay,
} from '../build-plugins/fuelDailyPagesPlugin';

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);

const COMO = { name: 'Como', province: 'CO', lat: 45.81, lng: 9.08, distanceKm: 0, fascia: '0-10' };
const CANTU = { name: 'Cantù', province: 'CO', lat: 45.74, lng: 9.13, distanceKm: 0, fascia: '0-10' };

function previousDataset(snapshotDay: string) {
  return {
    generatedAt: `${snapshotDay}T11:00:00.000Z`,
    sources: { italy: { provider: 'MIMIT Open Data', priceSnapshotDate: snapshotDay } },
    municipalities: [{
      municipality: 'Como',
      province: 'CO',
      italy: {
        stationCount: 1,
        stations: [{ id: '1', stationName: 'Eni Como', brand: 'Eni', address: 'Via Milano 10, 22100 Como', priceEur: 1.759, benzinaUpdatedAt: snapshotDay, isSelf: true }],
      },
    }],
  };
}

describe('generator: MIMIT outage keeps the Swiss refresh', () => {
  it('carries the previous Italian snapshot over with its own date', () => {
    const snapshot = day(daysAgo(7));
    const result = resolveItalySource({
      italyResult: { ok: false, error: new Error('fetch failed') },
      municipalities: [COMO],
      previousDataset: previousDataset(snapshot),
    });
    expect(result.status).toBe('carried-over');
    expect(result.extractedAt).toBe(snapshot);
    expect(result.reason).toBe('fetch failed');
    expect(result.italyByMunicipality.get('Como:CO')?.[0]?.priceEur).toBe(1.759);
  });

  it('reports unavailable (no invented rows) when nothing can be carried over', () => {
    const result = resolveItalySource({ italyResult: { ok: false, error: new Error('fetch failed') }, municipalities: [COMO], previousDataset: null });
    expect(result.status).toBe('unavailable');
    expect(result.extractedAt).toBeNull();
    expect(result.italyByMunicipality.size).toBe(0);
  });

  it('parses a live MIMIT read as before', () => {
    const today = day(NOW);
    const result = resolveItalySource({
      italyResult: {
        ok: true,
        pricesText: `Estrazione del ${today}\nidImpianto|descCarburante|prezzo|isSelf|dtComu\n1|Benzina|1.700|1|01/01/2026 08:00:00`,
        stationsText: `Estrazione del ${today}\nidImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine\n1|G|Eni|Stradale|Eni Como|Via Milano 10|COMO|CO|45.81|9.08`,
      },
      municipalities: [COMO],
      previousDataset: previousDataset(day(daysAgo(7))),
    });
    expect(result.status).toBe('live');
    expect(result.extractedAt).toBe(today);
  });

  it('rejects an HTTP-200 payload that is not a usable MIMIT export', () => {
    expect(() => validateMimitCsvPayload({
      pricesText: '<html>temporarily unavailable</html>',
      stationsText: '<html>temporarily unavailable</html>',
      municipalities: [COMO],
    })).toThrow('MIMIT prices CSV has no valid extraction date');
  });

  it('accepts a dated export only when it contains a target Benzina station', () => {
    const today = day(NOW);
    const observedDay = day(daysAgo(0.5)).split('-').reverse().join('/');
    const payload = validateMimitCsvPayload({
      pricesText: `Estrazione del ${today}\nidImpianto|descCarburante|prezzo|isSelf|dtComu\n1|Benzina|1.700|1|${observedDay} 08:00:00`,
      stationsText: `Estrazione del ${today}\nidImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine\n1|G|Eni|Stradale|Eni Como|Via Milano 10|COMO|CO|45.81|9.08`,
      municipalities: [COMO],
    });
    expect(payload.prices.extractedAt).toBe(today);
    expect(payload.stations.rows).toHaveLength(1);
  });

  it('rejects a valid export whose Benzina observations are older than 48 hours', () => {
    const today = day(NOW);
    const staleDay = day(daysAgo(3)).split('-').reverse().join('/');
    expect(() => validateMimitCsvPayload({
      pricesText: `Estrazione del ${today}\nidImpianto|descCarburante|prezzo|isSelf|dtComu\n1|Benzina|1.700|1|${staleDay} 08:00:00`,
      stationsText: `Estrazione del ${today}\nidImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine\n1|G|Eni|Stradale|Eni Como|Via Milano 10|COMO|CO|45.81|9.08`,
      municipalities: [COMO],
      now: NOW,
    })).toThrow('older than 48h');
  });

  it('uses the observation time instead of the end of its calendar day', () => {
    expect(() => validateMimitCsvPayload({
      pricesText: 'Estrazione del 2026-01-03\nidImpianto|descCarburante|prezzo|isSelf|dtComu\n1|Benzina|1.700|1|01/01/2026 10:00:00',
      stationsText: 'Estrazione del 2026-01-03\nidImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine\n1|G|Eni|Stradale|Eni Como|Via Milano 10|COMO|CO|45.81|9.08',
      municipalities: [COMO],
      now: new Date('2026-01-03T12:00:00.000Z'),
    })).toThrow('older than 48h');
  });

  it('labels the published Italian source with its status', () => {
    const carried = italyByMunicipalityFromDataset(previousDataset(day(daysAgo(3))));
    const payload = buildDataset({
      municipalities: [COMO],
      italyExtractedAt: day(daysAgo(3)),
      swissStations: [],
      italyByMunicipality: carried,
      exchangeRate: { chfPerEur: 1, eurPerChf: 1 },
      italyStatus: { status: 'carried-over', reason: 'fetch failed' },
    });
    expect(payload.sources.italy.status).toBe('carried-over');
    expect(payload.sources.italy.unavailableReason).toBe('fetch failed');
    expect(payload.sources.italy.priceSnapshotDate).toBe(day(daysAgo(3)));
    expect(payload.municipalities[0].italy.minPriceEur).toBe(1.759);

    const live = buildDataset({ municipalities: [COMO], italyExtractedAt: day(NOW), swissStations: [], italyByMunicipality: new Map(), exchangeRate: { chfPerEur: 1, eurPerChf: 1 } });
    expect(live.sources.italy.status).toBe('live');
    expect(live.sources.italy).not.toHaveProperty('unavailableReason');
  });
});

describe('generator: MIMIT Osservaprezzi API fallback', () => {
  const apiStation = (observedAt: Date) => ({
    id: 42,
    lat: String(COMO.lat),
    lon: String(COMO.lng),
    dIns: `${day(observedAt)} 08:00:00`,
    addr: 'VIA ROMA 1 22100 COMO CO',
    bnd: 'Eni',
    name: 'ENI COMO',
    carburanti: [
      { carb: 'Benzina', prezzo: '1.700', isSelf: 1 },
      { carb: 'Gasolio', prezzo: '1.650', isSelf: 1 },
    ],
  });

  it('normalizes the documented legacy response and preserves its observation day', () => {
    const observedAt = daysAgo(0.5);
    const apiRows = buildItalyRowsFromMimitApi({
      municipalities: [COMO],
      responses: [{ province: 'CO', results: [apiStation(observedAt)] }],
    });
    expect(apiRows.extractedAt).toBe(day(observedAt));
    expect(apiRows.stationsRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ idImpianto: '42', Comune: 'Como', Provincia: 'CO', Latitudine: '45.81', Longitudine: '9.08' }),
    ]));
    expect(apiRows.pricesRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ idImpianto: '42', descCarburante: 'Benzina', isSelf: '1', dtComu: day(observedAt) }),
      expect.objectContaining({ idImpianto: '42', descCarburante: 'Gasolio', isSelf: '1', dtComu: day(observedAt) }),
    ]));

    const stations = buildItalyStations([COMO], apiRows.stationsRows, apiRows.pricesRows);
    expect(stations.get('Como:CO')?.[0]).toEqual(expect.objectContaining({ priceEur: 1.7, dieselPriceEur: 1.65, benzinaUpdatedAt: day(observedAt) }));
  });

  it('accepts equivalent ISO and legacy observation aliases', () => {
    const observedAt = daysAgo(0.5);
    const observedDay = day(observedAt);
    const apiRows = buildItalyRowsFromMimitApi({
      municipalities: [COMO],
      responses: [{
        province: 'CO',
        results: [{
          ...apiStation(observedAt),
          insertDate: `${observedDay}T08:00:00Z`,
          dIns: `${observedDay} 08:00:00`,
        }],
      }],
    });
    expect(apiRows.stationsRows).toHaveLength(1);
    expect(apiRows.extractedAt).toBe(observedDay);
  });

  it('deduplicates an identical station returned twice by the API', () => {
    const station = {
      ...apiStation(daysAgo(0.5)),
      carburanti: [{ carb: 'Benzina', prezzo: '1.700', isSelf: 1 }],
    };
    const apiRows = buildItalyRowsFromMimitApi({
      municipalities: [COMO],
      responses: [{ province: 'CO', results: [station, station] }],
    });
    expect(apiRows.pricesRows).toHaveLength(1);
  });

  it('rejects rows whose municipality or observation date cannot be proven', () => {
    expect(() => buildItalyRowsFromMimitApi({
      municipalities: [COMO],
      responses: [{
        province: 'CO',
        results: [{
          ...apiStation(daysAgo(0.5)),
          addr: 'VIA ROMA 1 22100 CO',
          dIns: 'not-a-date',
        }],
      }],
    })).toThrow('no valid Benzina rows');
  });

  it('queries the official API by target province and accepts its array response', async () => {
    const observedAt = daysAgo(0.5);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await fetchMimitApiSource([COMO], {
      retries: 1,
      requestIntervalMs: 0,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ success: true, array: [apiStation(observedAt)] }) } as Response;
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/ospzApi/search/area');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      region: 3,
      province: 'CO',
      town: null,
      priceOrder: 'asc',
      fuelType: '1-x',
    });
    expect(result.source).toBe('mimit-api');
    expect(result.extractedAt).toBe(day(observedAt));
    expect(result.pricesRows).toHaveLength(2);
  });

  it('retries an empty province lookup with the target municipality', async () => {
    const observedAt = daysAgo(0.5);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await fetchMimitApiSource([COMO], {
      retries: 1,
      requestIntervalMs: 0,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => body.town == null
            ? { success: true, array: [] }
            : { success: true, results: [apiStation(observedAt)] },
        } as Response;
      },
    });

    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({ province: 'CO', town: null, fuelType: '1-x' });
    expect(JSON.parse(String(requests[1].init.body))).toMatchObject({ province: 'CO', town: 'Como', fuelType: '1-x' });
    expect(result.extractedAt).toBe(day(observedAt));
    expect(result.pricesRows).toHaveLength(2);
  });

  it('serializes province and town retries to avoid API rate-limit bursts', async () => {
    const observedAt = daysAgo(0.5);
    const requestStarts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await fetchMimitApiSource([COMO], {
      retries: 1,
      requestIntervalMs: 50,
      fetchImpl: async (url: string, init: RequestInit) => {
        requestStarts.push(Date.now());
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => body.town == null
            ? { success: true, array: [] }
            : { success: true, array: [apiStation(observedAt)] },
        } as Response;
      },
    });

    expect(result.source).toBe('mimit-api');
    expect(maxInFlight).toBe(1);
    expect(requestStarts).toHaveLength(2);
    expect(requestStarts[1] - requestStarts[0]).toBeGreaterThanOrEqual(45);
  });

  it('fails closed when a target municipality remains uncovered after the town retries', async () => {
    const observedAt = daysAgo(0.5);
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await expect(fetchMimitApiSource([COMO, CANTU], {
      retries: 1,
      requestIntervalMs: 0,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => body.town === 'Como'
            ? { success: true, results: [apiStation(observedAt)] }
            : { success: true, array: [] },
        } as Response;
      },
    })).rejects.toThrow('MIMIT API returned no valid Benzina rows for target municipalities');

    expect(requests.map(({ init }) => JSON.parse(String(init.body)).town).sort()).toEqual([null, 'Cantù', 'Como'].sort());
  });

  it('routes a live API result through the same source resolver as the CSV', () => {
    const apiRows = buildItalyRowsFromMimitApi({
      municipalities: [COMO],
      responses: [{ province: 'CO', results: [apiStation(daysAgo(0.5))] }],
    });
    const result = resolveItalySource({
      italyResult: { ok: true, source: 'mimit-api', ...apiRows },
      municipalities: [COMO],
      previousDataset: previousDataset(day(daysAgo(7))),
    });
    expect(result.status).toBe('live');
    expect(result.extractedAt).toBe(day(daysAgo(0.5)));
    expect(result.italyByMunicipality.get('Como:CO')?.[0]?.priceEur).toBe(1.7);
  });
});

describe('Italian "oggi" pages print the data day, not the build day', () => {
  it('latestItalianObservationDay picks the newest dated row for the fuel', () => {
    const stations = [
      { priceEur: 1.7, benzinaUpdatedAt: day(daysAgo(5)) },
      { priceEur: 1.8, benzinaUpdatedAt: day(daysAgo(2)) },
      { priceEur: 1.9, dieselPriceEur: 1.9, dieselUpdatedAt: day(NOW) },
    ] as never[];
    expect(latestItalianObservationDay(stations, 'benzina')).toBe(day(daysAgo(2)));
    expect(latestItalianObservationDay(stations, 'diesel')).toBe(day(NOW));
    expect(latestItalianObservationDay([{ priceEur: 1.7 }] as never[], 'benzina')).toBeNull();
  });

  it('isFuelObservationStale uses a 48h window from the end of the reporting day', () => {
    expect(isFuelObservationStale(day(NOW), NOW)).toBe(false);
    expect(isFuelObservationStale(day(daysAgo(1)), NOW)).toBe(false);
    expect(isFuelObservationStale(day(daysAgo(4)), NOW)).toBe(true);
    expect(isFuelObservationStale(null, NOW)).toBe(true);
  });

  it('a week-old MIMIT cut shows its own date in title and a stale note, never the build date', () => {
    const snapshot = day(daysAgo(7));
    const pages = generateFuelItalianCityPages({
      dataset: {
        generatedAt: NOW.toISOString(),
        municipalities: [{
          municipality: 'Como',
          province: 'CO',
          italy: { stations: [{ id: '1', stationName: 'Eni Como', brand: 'Eni', address: 'Via Milano 10, 22100 Como', priceEur: 1.759, benzinaUpdatedAt: snapshot, isSelf: true }] },
          swiss: { nearbyStations: [] },
        }],
      } as never,
      today: NOW,
    });
    const html = pages['/prezzi-benzina/italia/como/oggi/'];
    expect(html).toBeTruthy();
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    expect(title).toContain(snapshot);
    expect(title).not.toContain(day(NOW));
    expect(html).toContain(`Ultimo dato MIMIT disponibile: ${snapshot}`);
  });
});

describe('freshness gate (scripts/check-fuel-freshness.mjs)', () => {
  const fresh = {
    generatedAt: daysAgo(0.2).toISOString(),
    sources: {
      switzerland: { latestObservedUpdate: daysAgo(0.3).toISOString() },
      italy: { priceSnapshotDate: day(NOW), status: 'live' },
    },
  };

  it('passes when every source is within 48h', () => {
    const verdict = evaluateFuelFreshness({ fuel: fresh, cantons: { generatedAt: daysAgo(0.2).toISOString() }, now: NOW });
    expect(verdict.ok).toBe(true);
  });

  it('fails on the 2026-10-23 shape: TCS and MIMIT a week old', () => {
    const stale = {
      generatedAt: daysAgo(7).toISOString(),
      sources: { switzerland: { latestObservedUpdate: daysAgo(7).toISOString() }, italy: { priceSnapshotDate: day(daysAgo(8)) } },
    };
    const verdict = evaluateFuelFreshness({ fuel: stale, cantons: { generatedAt: daysAgo(0.5).toISOString() }, now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.filter((c) => c.stale).map((c) => c.key).sort()).toEqual(['generatedAt', 'mimit', 'tcs']);
  });

  it('fails on a carried-over MIMIT cut once it ages past the window, even with fresh TCS', () => {
    const fuel = { ...fresh, sources: { ...fresh.sources, italy: { priceSnapshotDate: day(daysAgo(4)), status: 'carried-over' } } };
    const verdict = evaluateFuelFreshness({ fuel, now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.find((c) => c.key === 'mimit')?.stale).toBe(true);
    expect(verdict.checks.find((c) => c.key === 'tcs')?.stale).toBe(false);
  });

  it('treats an undated or missing dataset as stale', () => {
    expect(evaluateFuelFreshness({ fuel: null, now: NOW }).ok).toBe(false);
  });

  it('is wired into the daily workflow after the publishing PR, with a stable-title issue and its resolver', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '..', '.github/workflows/update-fuel-prices.yml'), 'utf8');
    expect(workflow).toContain('node scripts/check-fuel-freshness.mjs --max-age-hours 48');
    expect(workflow.indexOf('Open PR with fuel price cache')).toBeLessThan(workflow.indexOf('Check fuel data freshness (max 48h)'));
    expect(workflow).toContain("if: steps.fuel_freshness.outcome == 'failure'");
    expect(workflow).toContain("if: steps.fuel_freshness.outcome == 'success'");
    expect(workflow.match(/--title "Dati carburante più vecchi di 48 ore \(update-fuel-prices\)"/g)).toHaveLength(2);
  });
});
