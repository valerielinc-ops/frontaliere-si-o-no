import { buildPath } from '@/services/router';
import type { Locale } from '@/services/i18n';
import type { FuelPricesDataset, FuelStationSwitzerland } from '@/services/fuelPricesService';
import type { InlineFuelPriceVariant } from '@/components/blog/fuelArticleContext';

export type InlineFuelPriceSourceClass = 'observed' | 'derived' | 'unknown';

export interface InlineFuelPriceRow {
  station: FuelStationSwitzerland;
  priceChf: number;
  sourceClass: InlineFuelPriceSourceClass;
  dieselSource: FuelStationSwitzerland['dieselSource'];
  updatedAt: string | null;
}

export interface InlineFuelPriceSections {
  observed: InlineFuelPriceRow[];
  derived: InlineFuelPriceRow[];
  unknown: InlineFuelPriceRow[];
}

function fuelPrice(row: FuelStationSwitzerland, variant: InlineFuelPriceVariant): number | null {
  const value = variant === 'diesel' ? row.dieselPriceChf : row.sp95PriceChf;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function dieselSourceClass(source: FuelStationSwitzerland['dieselSource']): InlineFuelPriceSourceClass {
  if (source === 'api' || source === 'scraped') return 'observed';
  if (source === 'derived' || source === 'monthly_average') return 'derived';
  return 'unknown';
}

function sourceClassPriority(sourceClass: InlineFuelPriceSourceClass): number {
  if (sourceClass === 'observed') return 0;
  if (sourceClass === 'derived') return 1;
  return 2;
}

function stationKey(station: FuelStationSwitzerland): string {
  return station.id || `${station.name}\u0000${station.address}`;
}

function candidateStations(dataset: FuelPricesDataset, variant: InlineFuelPriceVariant): FuelStationSwitzerland[] {
  const stations: FuelStationSwitzerland[] = [];
  if (variant === 'fuel') stations.push(...(dataset.rankings?.cheapestSwissStations ?? []));

  for (const municipality of dataset.municipalities ?? []) {
    stations.push(...(municipality.swiss?.nearbyStations ?? []));
    const selectedStation = variant === 'diesel'
      ? municipality.swiss?.cheapestDieselStation
      : municipality.swiss?.cheapestStation;
    if (selectedStation) stations.push(selectedStation);
  }

  return stations;
}

function compareRows(a: InlineFuelPriceRow, b: InlineFuelPriceRow): number {
  return a.priceChf - b.priceChf || a.station.name.localeCompare(b.station.name) || a.station.id.localeCompare(b.station.id);
}

export function prepareInlineFuelPriceSections(
  dataset: FuelPricesDataset,
  variant: InlineFuelPriceVariant,
  maxRows = 10,
): InlineFuelPriceSections {
  const limit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 10;
  const deduped = new Map<string, InlineFuelPriceRow>();

  for (const station of candidateStations(dataset, variant)) {
    const priceChf = fuelPrice(station, variant);
    if (priceChf === null) continue;

    const sourceClass = variant === 'diesel' ? dieselSourceClass(station.dieselSource) : 'observed';
    const row: InlineFuelPriceRow = {
      station,
      priceChf,
      sourceClass,
      dieselSource: variant === 'diesel' ? station.dieselSource : null,
      // Diesel dates are product-specific: do not reuse the petrol timestamp.
      updatedAt: variant === 'diesel'
        ? station.dieselUpdatedAt ?? null
        : station.updatedAt ?? null,
    };
    const key = stationKey(station);
    const current = deduped.get(key);
    if (!current
      || sourceClassPriority(row.sourceClass) < sourceClassPriority(current.sourceClass)
      || (row.sourceClass === current.sourceClass && row.priceChf < current.priceChf)) {
      deduped.set(key, row);
    }
  }

  const rows = [...deduped.values()];
  let remaining = limit;
  const takeSorted = (sourceClass: InlineFuelPriceSourceClass) => {
    const selected = rows
    .filter((row) => row.sourceClass === sourceClass)
    .sort(compareRows)
    .slice(0, remaining);
    remaining -= selected.length;
    return selected;
  };

  return {
    observed: takeSorted('observed'),
    derived: takeSorted('derived'),
    unknown: takeSorted('unknown'),
  };
}

export function buildFuelPriceComparisonHref(variant: InlineFuelPriceVariant, locale: Locale): string {
  const path = buildPath({ activeTab: 'stats', statsSubTab: 'fuel-prices' }, locale);
  return variant === 'diesel' ? `${path}?fuel=diesel` : path;
}
