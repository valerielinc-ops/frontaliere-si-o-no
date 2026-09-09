import { describe, expect, it } from 'vitest';
import { buildFuelViewSearch, datasetFreshness, fuelRowView, parseFuelViewState, type FuelViewState } from '../components/pages/FuelPriceStats';
import type { FuelPricesDataset, FuelStationItaly, FuelStationSwitzerland, MunicipalityFuelRow } from '../services/fuelPricesService';

const IT: FuelStationItaly = {
  id: 'it-1', stationName: 'Stazione Italia', brand: 'Test', address: 'Via Roma 1, Como', lat: 45.8, lng: 9.1,
  priceEur: 1.9, dieselPriceEur: 1.7, isSelf: true, updatedAt: '2026-09-09T08:00:00Z',
};
const CH: FuelStationSwitzerland = {
  id: 'ch-1', name: 'Stazione Svizzera', brand: 'Test', address: 'Via Test 1, Chiasso', lat: 45.84, lng: 9.03,
  sp95PriceChf: 2.1, dieselPriceChf: 1.8, sp95PriceEur: 2, dieselPriceEur: 1.7,
  updatedAt: '2026-09-09T08:00:00Z', nearestMunicipality: 'Como (CO)', nearestMunicipalityDistanceKm: 2, distanceKm: 5,
};

function row(overrides: Partial<MunicipalityFuelRow> = {}): MunicipalityFuelRow {
  return {
    municipality: 'Como', province: 'CO', lat: 45.8, lng: 9.1, distanceKm: 5, fascia: '1',
    italy: { stationCount: 1, minPriceEur: 1.9, avgPriceEur: 1.9, maxPriceEur: 1.9, minSelfPriceEur: 1.9, minServedPriceEur: null, minDieselPriceEur: null, avgDieselPriceEur: null, dieselStationCount: 1, cheapestStation: IT, stations: [IT] },
    swiss: { searchRadiusKm: 20, optionCount: 1, dieselOptionCount: 1, cheapestStation: CH, nearbyStations: [CH], minPriceChf: 2.1, minPriceEur: 2, minDieselPriceChf: null, minDieselPriceEur: null, cheapestDieselStation: null },
    comparison: { cheaperCountry: 'CH', priceDeltaEur: -0.1, saving50LEur: 5 },
    ...overrides,
  };
}

function dataset(overrides: Partial<FuelPricesDataset> = {}): FuelPricesDataset {
  return {
    generatedAt: '2026-09-09T11:00:00.000Z',
    sources: {
      italy: { provider: 'MIMIT', priceSnapshotDate: '2026-09-09', stationsUrl: '', pricesUrl: '' },
      switzerland: { provider: 'TCS', providerUrl: '', stationCount: 1, latestObservedUpdate: '2026-09-09T11:00:00.000Z' },
      exchangeRate: { provider: 'ECB', sourceUrl: '', chfPerEur: 1, eurPerChf: 1 },
    },
    summary: { municipalityCount: 1, municipalitiesWithItalyPrices: 1, municipalitiesWithSwissComparison: 1, cheaperItalyCount: 0, cheaperSwissCount: 1, tieCount: 0, cheapestItalyMunicipality: null, cheapestSwissStation: null },
    rankings: { cheapestItalyMunicipalities: [], cheapestSwissStations: [], bestCrossBorderSavings: [] },
    municipalities: [row()],
    ...overrides,
  };
}

describe('fuel comparison view model', () => {
  it('round-trips shareable controls without creating an indexed route', () => {
    const state: FuelViewState = { fuelType: 'diesel', search: 'Como centro', province: 'CO', sortKey: 'swiss', selectedKey: 'Como|CO', homeMunicipalityKey: 'Como|CO', tankLiters: 65, costPerKmEur: 0.23, page: 3 };
    expect(parseFuelViewState(`?${buildFuelViewSearch(state)}`)).toEqual(state);
    expect(buildFuelViewSearch({ ...state, fuelType: 'benzina', search: '', province: 'ALL', sortKey: 'saving', selectedKey: null, homeMunicipalityKey: '', tankLiters: 50, costPerKmEur: 0.18, page: 1 })).toBe('');
  });

  it('does not use benzina prices when diesel aggregates are unavailable', () => {
    const view = fuelRowView(row({
      italy: { ...row().italy, minPriceEur: 1.95, minDieselPriceEur: null, stations: [{ ...IT, dieselPriceEur: 1.7 }] },
      swiss: { ...row().swiss, minPriceEur: 2.1, minDieselPriceEur: null, nearbyStations: [{ ...CH, dieselPriceEur: 1.7 }] },
    }), 'diesel');
    expect(view.italy.minPriceEur).toBe(1.7);
    expect(view.swiss.minPriceEur).toBe(1.7);
    expect(view.comparison.cheaperCountry).toBe('SAME');
  });

  it('keeps the diesel-cheapest station visible when the list is benzina-ranked', () => {
    const dieselCheapest = { ...CH, id: 'ch-diesel', dieselPriceChf: 1.6, dieselPriceEur: 1.5 };
    const view = fuelRowView(row({ swiss: { ...row().swiss, nearbyStations: [CH], cheapestDieselStation: dieselCheapest, minDieselPriceChf: 1.6, minDieselPriceEur: 1.5 } }), 'diesel');
    expect(view.swiss.nearbyStations[0]?.id).toBe('ch-diesel');
    expect(view.swiss.minPriceEur).toBe(1.5);
  });
});

describe('fuel data freshness', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');

  it('requires every source timestamp to be within the freshness window', () => {
    expect(datasetFreshness(dataset(), now)).toBe('current');
    expect(datasetFreshness(dataset({ sources: { ...dataset().sources, italy: { ...dataset().sources.italy, priceSnapshotDate: '2026-09-07' } } }), now)).toBe('stale');
  });

  it('returns unknown only when no usable timestamp exists', () => {
    expect(datasetFreshness(dataset({ generatedAt: '', sources: { ...dataset().sources, italy: { ...dataset().sources.italy, priceSnapshotDate: null }, switzerland: { ...dataset().sources.switzerland, latestObservedUpdate: null } } }), now)).toBe('unknown');
  });
});
