import { describe, expect, it } from 'vitest';
import {
  OSM_FUEL_SOURCE,
  parseOsmFuelGeoJson,
  mergeSwissStationInventories,
  pointFromOsmFeature,
} from '../scripts/lib/fuel-openstreetmap.mjs';

const resolveTi = ({ lat, lng }: { lat: number; lng: number }) => (
  lat > 45.7 && lat < 46.3 && lng > 8.5 && lng < 9.2 ? 'TI' : null
);

describe('OpenStreetMap fuel inventory adapter', () => {
  it('normalises point and polygon fuel features into price-less inventory rows', () => {
    const stations = parseOsmFuelGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'node/123',
          properties: {
            name: 'Avia Lugano',
            brand: 'AVIA',
            'addr:street': 'Via Cantonale',
            'addr:housenumber': '10',
            'addr:postcode': '6900',
            'addr:city': 'Lugano',
            'fuel:octane_95': 'yes',
            'fuel:diesel': 'yes',
          },
          geometry: { type: 'Point', coordinates: [8.95, 46.01] },
        },
        {
          type: 'Feature',
          id: 'way/456',
          properties: { name: 'Shell Mendrisio', brand: 'Shell', 'fuel:octane_95': 'yes' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[8.98, 45.86], [8.981, 45.86], [8.981, 45.861], [8.98, 45.86]]],
          },
        },
      ],
    }, { observedAt: '2026-10-29T04:17:00.000Z', cantonResolver: resolveTi });

    expect(stations).toHaveLength(2);
    expect(stations[0]).toMatchObject({
      id: 'osm:node/123',
      source: OSM_FUEL_SOURCE,
      sp95PriceChf: null,
      dieselPriceChf: null,
      priceStatus: { sp95: 'unavailable', diesel: 'unavailable' },
      canton: 'TI',
      fuelTypes: ['octane_95', 'diesel'],
      updatedAt: null,
    });
    expect(stations[1]?.lat).toBeCloseTo(45.860333, 5);
  });

  it('drops aviation-only fuel objects and keeps objects without subtype tags', () => {
    const stations = parseOsmFuelGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature', id: 'node/aviation', properties: { name: 'Airport fuel', 'fuel:avgas': 'yes' },
          geometry: { type: 'Point', coordinates: [8.95, 46.01] },
        },
        {
          type: 'Feature', id: 'node/unknown', properties: { name: 'Unnamed road station' },
          geometry: { type: 'Point', coordinates: [8.96, 46.02] },
        },
      ],
    }, { cantonResolver: resolveTi });

    expect(stations.map((station) => station.id)).toEqual(['osm:node/unknown']);
  });

  it('matches a nearby OSM station to its TCS price row without inventing a price', () => {
    const tcs = [{
      id: 'tcs-1', name: 'AVIA Lugano', brand: 'AVIA', address: 'Via Cantonale 10, 6900 Lugano',
      lat: 46.01, lng: 8.95, sp95PriceChf: 1.91, dieselPriceChf: 2.02,
      updatedAt: '2026-10-29T04:00:00.000Z', observedAt: '2026-10-29T04:00:00.000Z', source: 'tcs',
    }];
    const osm = [{
      id: 'osm:node/123', name: 'Avia Lugano', brand: 'AVIA', address: 'Via Cantonale 10, 6900 Lugano',
      lat: 46.0104, lng: 8.9502, sp95PriceChf: null, dieselPriceChf: null,
      updatedAt: null, observedAt: '2026-10-29T04:17:00.000Z', source: OSM_FUEL_SOURCE,
      inventorySource: OSM_FUEL_SOURCE, inventoryId: 'osm:node/123', canton: 'TI', fuelTypes: ['octane_95', 'diesel'],
      priceStatus: { sp95: 'unavailable', diesel: 'unavailable' },
    }];
    const merged = mergeSwissStationInventories(tcs, osm);

    expect(merged.matchCount).toBe(1);
    expect(merged.inventoryOnlyCount).toBe(0);
    expect(merged.stations).toHaveLength(1);
    expect(merged.stations[0]).toMatchObject({
      id: 'tcs-1', sp95PriceChf: 1.91, dieselPriceChf: 2.02,
      inventorySource: OSM_FUEL_SOURCE, inventoryId: 'osm:node/123', canton: 'TI',
    });
  });

  it('retains an OSM-only station when no conservative TCS match exists', () => {
    const merged = mergeSwissStationInventories([
      { id: 'tcs-1', name: 'Shell', brand: 'Shell', address: 'Via Roma 1, 6900 Lugano', lat: 46.01, lng: 8.95, sp95PriceChf: 1.9 },
    ], [{
      id: 'osm:node/999', name: 'Agrola', brand: 'Agrola', address: 'Dorfstrasse 4, 8000 Zürich',
      lat: 47.38, lng: 8.54, sp95PriceChf: null, dieselPriceChf: null, source: OSM_FUEL_SOURCE,
    }]);

    expect(merged.matchCount).toBe(0);
    expect(merged.inventoryOnlyCount).toBe(1);
    expect(merged.stations.at(-1)).toMatchObject({ id: 'osm:node/999', sp95PriceChf: null });
  });

  it('derives a representative point for a polygon feature', () => {
    expect(pointFromOsmFeature({
      geometry: { type: 'Polygon', coordinates: [[[8, 46], [9, 46], [9, 47], [8, 46]]] },
    })).toEqual({ lat: 46.333333333333336, lng: 8.666666666666666 });
  });
});
