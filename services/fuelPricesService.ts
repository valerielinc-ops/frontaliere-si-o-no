export type FuelComparisonCountry = 'IT' | 'CH' | 'SAME' | 'NO_DATA';

export interface FuelStationItaly {
  id: string;
  stationName: string;
  brand: string;
  address: string;
  lat: number | null;
  lng: number | null;
  priceEur: number;
  isSelf: boolean;
  updatedAt: string | null;
}

export interface FuelStationSwitzerland {
  id: string;
  name: string;
  brand: string;
  address: string;
  lat: number;
  lng: number;
  sp95PriceChf: number;
  sp95PriceEur: number;
  updatedAt: string | null;
  nearestMunicipality: string | null;
  nearestMunicipalityDistanceKm: number;
  distanceKm?: number;
}

export interface MunicipalityFuelRow {
  municipality: string;
  province: string;
  lat: number;
  lng: number;
  distanceKm: number;
  fascia: string;
  italy: {
    stationCount: number;
    minPriceEur: number | null;
    avgPriceEur: number | null;
    maxPriceEur: number | null;
    minSelfPriceEur: number | null;
    minServedPriceEur: number | null;
    cheapestStation: FuelStationItaly | null;
    stations: FuelStationItaly[];
  };
  swiss: {
    searchRadiusKm: number;
    optionCount: number;
    cheapestStation: FuelStationSwitzerland | null;
    nearbyStations: FuelStationSwitzerland[];
    minPriceChf: number | null;
    minPriceEur: number | null;
  };
  comparison: {
    cheaperCountry: FuelComparisonCountry;
    priceDeltaEur: number | null;
    saving50LEur: number | null;
  };
}

export interface FuelPricesDataset {
  generatedAt: string;
  sources: {
    italy: {
      provider: string;
      priceSnapshotDate: string | null;
      stationsUrl: string;
      pricesUrl: string;
    };
    switzerland: {
      provider: string;
      providerUrl: string;
      stationCount: number;
      latestObservedUpdate: string | null;
    };
    exchangeRate: {
      provider: string;
      sourceUrl: string;
      chfPerEur: number;
      eurPerChf: number;
    };
  };
  summary: {
    municipalityCount: number;
    municipalitiesWithItalyPrices: number;
    municipalitiesWithSwissComparison: number;
    cheaperItalyCount: number;
    cheaperSwissCount: number;
    tieCount: number;
    cheapestItalyMunicipality: {
      municipality: string;
      province: string;
      minPriceEur: number;
      cheapestStation: FuelStationItaly | null;
    } | null;
    cheapestSwissStation: FuelStationSwitzerland | null;
  };
  rankings: {
    cheapestItalyMunicipalities: Array<{
      municipality: string;
      province: string;
      minPriceEur: number;
      cheapestStation: FuelStationItaly | null;
    }>;
    cheapestSwissStations: FuelStationSwitzerland[];
    bestCrossBorderSavings: Array<{
      municipality: string;
      province: string;
      cheaperCountry: FuelComparisonCountry;
      saving50LEur: number | null;
      italyPriceEur: number | null;
      swissPriceEur: number | null;
      swissPriceChf: number | null;
      swissStation: FuelStationSwitzerland | null;
    }>;
  };
  municipalities: MunicipalityFuelRow[];
}

let cache: FuelPricesDataset | null = null;

export async function fetchFuelPrices(forceRefresh = false): Promise<FuelPricesDataset> {
  if (cache && !forceRefresh) return cache;
  const suffix = forceRefresh ? `?t=${Date.now()}` : '';
  const response = await fetch(`/data/fuel-prices.json${suffix}`, {
    cache: forceRefresh ? 'no-store' : 'default',
  });
  if (!response.ok) {
    throw new Error(`Fuel dataset unavailable (${response.status})`);
  }
  const json = await response.json() as FuelPricesDataset;
  cache = json;
  return json;
}
