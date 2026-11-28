/**
 * The fuel sitemap must advertise exactly the Italian city pages that are
 * emitted. A city whose stations report no Gasolio price gets a benzina page
 * but no diesel page, so its diesel URL must never be listed (404-risk #19892).
 */
import { describe, expect, it } from 'vitest';
import {
  generateFuelItalianCityPages,
  isItalianCityFuelPageEmitted,
  listEmittedItalianCityFuelPaths,
} from '../build-plugins/fuelDailyPagesPlugin';

const TODAY = new Date('2026-05-18T06:00:00Z');

const station = (id: string, diesel: number | null) => ({
  id,
  brand: 'Eni',
  stationName: `Eni ${id}`,
  address: `Via Roma 1, ${id}`,
  priceEur: 1.85,
  dieselPriceEur: diesel,
  benzinaUpdatedAt: '2026-05-10',
  dieselUpdatedAt: diesel === null ? undefined : '2026-05-11',
  updatedAt: '2026-05-17',
  isSelf: true,
  lat: 45.8,
  lng: 9.08,
});

const DATASET = {
  generatedAt: TODAY.toISOString(),
  municipalities: [
    { municipality: 'Como', province: 'CO', italy: { stations: [station('c1', 1.8)] } },
    { municipality: 'Colorina', province: 'SO', italy: { dieselStationCount: 0, stations: [station('k1', null)] } },
  ],
} as never;

describe('fuel sitemap parity with emitted Italian city pages', () => {
  const emitted = listEmittedItalianCityFuelPaths(DATASET);
  const pages = generateFuelItalianCityPages({ dataset: DATASET, today: TODAY });

  it('lists every emitted page and nothing else (one predicate for both)', () => {
    expect([...emitted].sort()).toEqual(Object.keys(pages).sort());
  });

  it('does not list the diesel page of a city without diesel prices', () => {
    expect([...emitted].filter((p) => /diesel|gasoil|dieselpreis/.test(p) && /colorina/.test(p))).toEqual([]);
    expect(emitted.has('/prezzi-benzina/italia/colorina/oggi/')).toBe(true);
    expect(emitted.has('/prezzi-diesel/italia/colorina/oggi/')).toBe(false);
    expect(emitted.has('/prezzi-diesel/italia/como/oggi/')).toBe(true);
  });

  it('exposes the predicate for callers', () => {
    expect(typeof isItalianCityFuelPageEmitted).toBe('function');
  });
});
