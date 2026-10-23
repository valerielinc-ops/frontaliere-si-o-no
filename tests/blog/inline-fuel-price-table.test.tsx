import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FuelPricesDataset, FuelStationSwitzerland } from '../../services/fuelPricesService';

const mocks = vi.hoisted(() => ({
  locale: 'en' as 'it' | 'en' | 'de' | 'fr',
  fetchFuelPrices: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
  useLocale: () => [mocks.locale],
  useTranslation: () => ({ locale: mocks.locale, t: (key: string) => key }),
  getLocale: () => mocks.locale,
}));

vi.mock('@/services/fuelPricesService', () => ({
  fetchFuelPrices: mocks.fetchFuelPrices,
}));

import InlineFuelPriceTable from '../../components/blog/InlineFuelPriceTable';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function makeDataset(stations: FuelStationSwitzerland[] = []): FuelPricesDataset {
  return {
    generatedAt: minutesAgo(5),
    sources: {
      italy: { provider: 'MIMIT', priceSnapshotDate: null, stationsUrl: '', pricesUrl: '' },
      switzerland: { provider: 'TCS', providerUrl: '', stationCount: stations.length, latestObservedUpdate: null },
      exchangeRate: { provider: 'ECB', sourceUrl: '', chfPerEur: 1, eurPerChf: 1 },
    },
    summary: {
      municipalityCount: 0,
      municipalitiesWithItalyPrices: 0,
      municipalitiesWithSwissComparison: 0,
      cheaperItalyCount: 0,
      cheaperSwissCount: 0,
      tieCount: 0,
      cheapestItalyMunicipality: null,
      cheapestSwissStation: null,
    },
    rankings: { cheapestItalyMunicipalities: [], cheapestSwissStations: [], bestCrossBorderSavings: [] },
    municipalities: [{
      municipality: 'Chiasso',
      province: 'Como',
      lat: 46,
      lng: 8.9,
      distanceKm: 1,
      fascia: 'border',
      italy: { stationCount: 0, minPriceEur: null, avgPriceEur: null, maxPriceEur: null, minSelfPriceEur: null, minServedPriceEur: null, cheapestStation: null, stations: [] },
      swiss: { searchRadiusKm: 20, optionCount: stations.length, cheapestStation: null, nearbyStations: stations, minPriceChf: null, minPriceEur: null },
      comparison: { cheaperCountry: 'NO_DATA', priceDeltaEur: null, saving50LEur: null },
    }],
  };
}

function makeStation(overrides: Partial<FuelStationSwitzerland> = {}): FuelStationSwitzerland {
  return {
    id: 'station-1',
    name: 'Test station',
    brand: 'Test brand',
    address: 'Via Test 1',
    lat: 46,
    lng: 8.9,
    sp95PriceChf: 2.03,
    dieselPriceChf: 1.87,
    dieselSource: 'api',
    dieselUpdatedAt: null,
    sp95PriceEur: 1.9,
    dieselPriceEur: 1.75,
    updatedAt: minutesAgo(90),
    nearestMunicipality: 'Chiasso',
    nearestMunicipalityDistanceKm: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InlineFuelPriceTable', () => {
  it('renders the selected diesel price, its own date and the comparison link with diesel selected', async () => {
    mocks.locale = 'en';
    mocks.fetchFuelPrices.mockResolvedValueOnce(makeDataset([makeStation()]));

    render(<InlineFuelPriceTable variant="diesel" />);

    await screen.findByTestId('inline-fuel-price-table');
    expect(screen.getByRole('heading', { name: 'Live diesel prices — Swiss stations' })).toBeInTheDocument();
    expect(screen.getByText('Diesel CHF/L')).toBeInTheDocument();
    expect(screen.getByText('1.87')).toBeInTheDocument();
    expect(screen.getByText('Observed prices')).toBeInTheDocument();
    expect(screen.getByText('Diesel collection date: —')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open fuel comparison/ })).toHaveAttribute(
      'href',
      '/en/statistics/border-fuel-prices/?fuel=diesel',
    );
  });

  it('keeps the comparison link available when the selected fuel has no valid prices', async () => {
    mocks.locale = 'it';
    mocks.fetchFuelPrices.mockResolvedValueOnce(makeDataset());

    render(<InlineFuelPriceTable variant="fuel" />);

    await screen.findByTestId('inline-fuel-price-table-empty');
    expect(screen.getByRole('link', { name: /Apri confronto carburanti/ })).toHaveAttribute(
      'href',
      '/statistiche/prezzi-benzina-confine/',
    );
  });

  it('keeps the comparison link available when live data fails', async () => {
    mocks.locale = 'de';
    mocks.fetchFuelPrices.mockRejectedValueOnce(new Error('offline'));

    render(<InlineFuelPriceTable variant="diesel" />);

    await screen.findByTestId('inline-fuel-price-table-error');
    expect(screen.getByRole('link', { name: /Kraftstoffvergleich öffnen/ })).toHaveAttribute(
      'href',
      '/de/statistiken/spritpreise-grenze/?fuel=diesel',
    );
  });
});
