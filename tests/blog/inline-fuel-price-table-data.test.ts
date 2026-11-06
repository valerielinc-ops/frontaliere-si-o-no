import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FuelPricesDataset, FuelStationSwitzerland } from '../../services/fuelPricesService';
import { FUEL_PRICE_ARTICLE_VARIANTS, fuelPriceVariantForArticle, shouldShowFuelTableAfterSingleSegment } from '../../components/blog/fuelArticleContext';
import {
  buildFuelPriceComparisonHref,
  prepareInlineFuelPriceSections,
} from '../../components/blog/inlineFuelPriceTableData';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const BLOG_ARTICLES = readFileSync(resolve(__dirname, '../../components/community/BlogArticles.tsx'), 'utf8');

function station(id: string, overrides: Partial<FuelStationSwitzerland> = {}): FuelStationSwitzerland {
  return {
    id,
    name: id,
    brand: 'Test brand',
    address: 'Via Test 1',
    lat: 46,
    lng: 8.9,
    sp95PriceChf: 1.9,
    dieselPriceChf: null,
    sp95PriceEur: 1.8,
    dieselPriceEur: null,
    updatedAt: minutesAgo(90),
    dieselUpdatedAt: null,
    dieselSource: null,
    nearestMunicipality: 'Chiasso',
    nearestMunicipalityDistanceKm: 1,
    ...overrides,
  };
}

function dataset(
  nearbyStations: FuelStationSwitzerland[][] = [],
  cheapestSwissStations: FuelStationSwitzerland[] = [],
  cheapestDieselStations: Array<FuelStationSwitzerland | null> = [],
): FuelPricesDataset {
  return {
    generatedAt: minutesAgo(30),
    sources: {
      italy: { provider: 'MIMIT', priceSnapshotDate: null, stationsUrl: '', pricesUrl: '' },
      switzerland: { provider: 'TCS', providerUrl: '', stationCount: 0, latestObservedUpdate: null },
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
    rankings: {
      cheapestItalyMunicipalities: [],
      cheapestSwissStations,
      bestCrossBorderSavings: [],
    },
    municipalities: nearbyStations.map((stations, index) => ({
      municipality: `Municipality ${index}`,
      province: 'Como',
      lat: 46,
      lng: 8.9,
      distanceKm: 1,
      fascia: 'border',
      italy: {
        stationCount: 0,
        minPriceEur: null,
        avgPriceEur: null,
        maxPriceEur: null,
        minSelfPriceEur: null,
        minServedPriceEur: null,
        cheapestStation: null,
        stations: [],
      },
      swiss: {
        searchRadiusKm: 20,
        optionCount: stations.length,
        cheapestStation: null,
        nearbyStations: stations,
        minPriceChf: null,
        minPriceEur: null,
        cheapestDieselStation: cheapestDieselStations[index] ?? null,
      },
      comparison: { cheaperCountry: 'NO_DATA', priceDeltaEur: null, saving50LEur: null },
    })),
  };
}

describe('inline fuel price table data', () => {
  it('maps article context explicitly and leaves unrelated articles unconfigured', () => {
    expect(FUEL_PRICE_ARTICLE_VARIANTS).toEqual({
      'diesel-aumento-prezzi-svizzera-2026': 'diesel',
      'carburanti-ticino-aumento-prezzi': 'fuel',
    });
    expect(FUEL_PRICE_ARTICLE_VARIANTS['diesel-generico']).toBeUndefined();
    expect(fuelPriceVariantForArticle('toString')).toBeUndefined();
    expect(fuelPriceVariantForArticle('constructor')).toBeUndefined();
    expect(fuelPriceVariantForArticle('diesel-aumento-prezzi-svizzera-2026')).toBe('diesel');
  });

  it('ranks petrol by SP95 price rather than by diesel price', () => {
    const petrolCheaper = station('petrol-cheaper', { sp95PriceChf: 1.82, dieselPriceChf: 2.15, dieselSource: 'api' });
    const dieselCheaper = station('diesel-cheaper', { sp95PriceChf: 1.94, dieselPriceChf: 1.79, dieselSource: 'api' });

    const sections = prepareInlineFuelPriceSections(dataset([[dieselCheaper, petrolCheaper]], [dieselCheaper, petrolCheaper]), 'fuel');

    expect(sections.observed.map((row) => [row.station.id, row.priceChf])).toEqual([
      ['petrol-cheaper', 1.82],
      ['diesel-cheaper', 1.94],
    ]);
    expect(sections.derived).toEqual([]);
    expect(sections.unknown).toEqual([]);
  });

  it('ranks all municipality diesel observations and separates estimates and unknown sources', () => {
    const observedMoreExpensive = station('observed-1', {
      sp95PriceChf: 1.75,
      dieselPriceChf: 1.98,
      dieselSource: 'api',
      dieselUpdatedAt: minutesAgo(120),
    });
    const observedCheapest = station('observed-2', {
      sp95PriceChf: 2.1,
      dieselPriceChf: 1.86,
      dieselSource: 'scraped',
      dieselUpdatedAt: null,
    });
    const estimated = station('estimated', { dieselPriceChf: 1.75, dieselSource: 'derived' });
    const monthlyAverage = station('monthly-average', { dieselPriceChf: 1.81, dieselSource: 'monthly_average' });
    const unknown = station('unknown', { dieselPriceChf: 1.7, dieselSource: null });
    const invalid = station('invalid', { dieselPriceChf: 0, dieselSource: 'api' });
    const truncatedSp95Ranking = station('sp95-only', { sp95PriceChf: 1.7, dieselPriceChf: null });

    const sections = prepareInlineFuelPriceSections(
      dataset(
        [[observedMoreExpensive, observedCheapest, estimated, monthlyAverage, unknown, invalid]],
        [truncatedSp95Ranking],
      ),
      'diesel',
    );

    expect(sections.observed.map((row) => row.station.id)).toEqual(['observed-2', 'observed-1']);
    expect(sections.derived.map((row) => [row.station.id, row.sourceClass])).toEqual([
      ['estimated', 'derived'],
      ['monthly-average', 'derived'],
    ]);
    expect(sections.unknown.map((row) => [row.station.id, row.sourceClass])).toEqual([['unknown', 'unknown']]);
    expect(sections.observed[0].updatedAt).toBeNull();
    expect([...sections.observed, ...sections.derived, ...sections.unknown].some((row) => row.station.id === 'sp95-only')).toBe(false);
    expect([...sections.observed, ...sections.derived, ...sections.unknown].some((row) => row.station.id === 'invalid')).toBe(false);
  });

  it('does not reuse a petrol date as a diesel date and deduplicates diesel candidates', () => {
    const derived = station('shared', { dieselPriceChf: 1.7, dieselSource: 'derived' });
    const observed = station('shared', { dieselPriceChf: 1.9, dieselSource: 'api', dieselUpdatedAt: null });
    const extraCheapest = station('cheapest-diesel', { dieselPriceChf: 1.8, dieselSource: 'api' });

    const sections = prepareInlineFuelPriceSections(dataset([[derived, observed]], [], [extraCheapest]), 'diesel');

    expect(sections.observed.map((row) => row.station.id)).toEqual(['cheapest-diesel', 'shared']);
    expect(sections.derived).toEqual([]);
    expect(sections.observed.find((row) => row.station.id === 'shared')?.updatedAt).toBeNull();
  });

  it('builds localized canonical comparison links and retains the selected fuel', () => {
    expect(buildFuelPriceComparisonHref('fuel', 'it')).toBe('/statistiche/prezzi-benzina-confine/');
    expect(buildFuelPriceComparisonHref('diesel', 'it')).toBe('/statistiche/prezzi-benzina-confine/?fuel=diesel');
    expect(buildFuelPriceComparisonHref('diesel', 'en')).toBe('/en/statistics/border-fuel-prices/?fuel=diesel');
    expect(buildFuelPriceComparisonHref('diesel', 'de')).toBe('/de/statistiken/spritpreise-grenze/?fuel=diesel');
    expect(buildFuelPriceComparisonHref('diesel', 'fr')).toBe('/fr/statistiques/prix-essence-frontiere/?fuel=diesel');
  });

  it('places the widget after a short single-segment article body', () => {
    expect(shouldShowFuelTableAfterSingleSegment(1, 0)).toBe(true);
    expect(shouldShowFuelTableAfterSingleSegment(2, 0)).toBe(false);
    expect(shouldShowFuelTableAfterSingleSegment(2, 1)).toBe(false);
  });

  it('passes the explicit article fuel through to the widget and keeps the short-body insertion path', () => {
    expect(BLOG_ARTICLES).toContain('fuelPriceVariantForArticle(article.id)');
    expect(BLOG_ARTICLES).toContain('<InlineFuelPriceTable variant={fuelPriceVariant} maxRows={10} />');
    expect(BLOG_ARTICLES).toContain('shouldShowFuelTableAfterSingleSegment(presentSegments.length, idx)');
  });

  it('applies maxRows to the total across source groups, keeping observed prices first', () => {
    const sections = prepareInlineFuelPriceSections(dataset([[
      station('observed-1', { dieselPriceChf: 1.9, dieselSource: 'api' }),
      station('observed-2', { dieselPriceChf: 1.95, dieselSource: 'api' }),
      station('derived-1', { dieselPriceChf: 1.7, dieselSource: 'derived' }),
      station('unknown-1', { dieselPriceChf: 1.6, dieselSource: 'unknown' }),
    ]]), 'diesel', 3);

    expect(sections.observed.map((row) => row.station.id)).toEqual(['observed-1', 'observed-2']);
    expect(sections.derived.map((row) => row.station.id)).toEqual(['derived-1']);
    expect(sections.unknown).toEqual([]);
  });
});
