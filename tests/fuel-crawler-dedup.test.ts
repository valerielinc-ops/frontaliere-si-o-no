/**
 * Regression tests for AE-9: fuel-station crawler dedup.
 *
 * Root-cause: the TCS Firestore feed emitted two Eni Caslano documents
 * (distinct ids, same brand + name + address, ~700 m coordinate drift).
 * Downstream this produced two per-station SEO pages —
 * `/prezzi-diesel/stazione/eni-caslano/` and
 * `/prezzi-diesel/stazione/eni-caslano-2/` — classed by Google as a
 * cannibalization cluster.
 *
 * These tests guard the upstream dedup function in
 * `scripts/lib/fuel-station-dedup.mjs`, plus the defensive plugin-level
 * dedup that protects against already-persisted duplicates in
 * `data/fuel-prices.json`.
 */

import { describe, expect, it, vi } from 'vitest';

import { dedupFuelStations, stationDedupKey, normalizeField, roundCoord } from '../scripts/lib/fuel-station-dedup.mjs';

import { generateFuelStationPages } from '../build-plugins/fuelDailyPagesPlugin';
import { FUEL_STATIONS_SLUG } from '../build-plugins/fuelDailyData';

describe('normalizeField', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalizeField('Zürcherstrasse')).toBe('zurcherstrasse');
    expect(normalizeField('Città')).toBe('citta');
  });

  it('collapses non-alphanumerics to single spaces', () => {
    expect(normalizeField('Via  Cantonale,  36')).toBe('via cantonale 36');
    expect(normalizeField('  ENI — Caslano  ')).toBe('eni caslano');
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeField(null)).toBe('');
    expect(normalizeField(undefined)).toBe('');
    expect(normalizeField('')).toBe('');
  });
});

describe('roundCoord', () => {
  it('rounds to 4 decimals by default (~11 m precision)', () => {
    expect(roundCoord(45.97394481908457)).toBe(45.9739);
    expect(roundCoord(45.97979876673632)).toBe(45.9798);
  });

  it('returns null for non-finite input', () => {
    expect(roundCoord(null)).toBeNull();
    expect(roundCoord(undefined)).toBeNull();
    expect(roundCoord(NaN)).toBeNull();
  });
});

describe('stationDedupKey', () => {
  it('returns the same key for two Eni Caslano records with coord drift', () => {
    const a = {
      id: 'TyVGrppSLdVuEl3mGLQi',
      name: 'Eni',
      brand: 'ENI',
      address: 'Via Cantonale 36, 6987 Caslano',
      lat: 45.97394481908457,
      lng: 8.869804789687063,
    };
    const b = {
      id: 'feGaE8DvyVQLWX2KWvCM',
      name: 'Eni',
      brand: 'ENI',
      address: 'Via Cantonale 36, 6987 Caslano',
      lat: 45.97979876673632,
      lng: 8.877340395031382,
    };
    expect(stationDedupKey(a)).toBe(stationDedupKey(b));
  });

  it('produces distinct keys for genuinely different stations', () => {
    const caslano = {
      name: 'Eni',
      brand: 'ENI',
      address: 'Via Cantonale 36, 6987 Caslano',
    };
    const stabio = {
      name: 'Eni Stabio',
      brand: 'ENI',
      address: 'Via Gaggiolo 28, 6855 Stabio',
    };
    expect(stationDedupKey(caslano)).not.toBe(stationDedupKey(stabio));
  });

  it('is case- and diacritic-insensitive', () => {
    const a = { name: 'Eni', brand: 'ENI', address: 'Via Cantonale 36, 6987 Caslano' };
    const b = { name: 'eni', brand: 'eni', address: 'VIA  CANTONALE  36, 6987 CASLANO' };
    expect(stationDedupKey(a)).toBe(stationDedupKey(b));
  });
});

describe('dedupFuelStations', () => {
  it('merges the two Eni Caslano records into one (Firestore real-data scenario)', () => {
    const logger = vi.fn();
    const input = [
      {
        id: 'TyVGrppSLdVuEl3mGLQi',
        name: 'Eni',
        brand: 'ENI',
        address: 'Via Cantonale 36, 6987 Caslano',
        lat: 45.97394481908457,
        lng: 8.869804789687063,
        sp95PriceChf: 1.78,
        dieselPriceChf: 2.07,
        updatedAt: '2026-04-18T13:43:03.407Z',
      },
      {
        id: 'feGaE8DvyVQLWX2KWvCM',
        name: 'Eni',
        brand: 'ENI',
        address: 'Via Cantonale 36, 6987 Caslano',
        lat: 45.97979876673632,
        lng: 8.877340395031382,
        sp95PriceChf: 1.79,
        dieselPriceChf: null,
        updatedAt: '2026-04-10T09:00:00.000Z',
      },
    ];
    const result = dedupFuelStations(input, { logger });
    expect(result).toHaveLength(1);
    // Winner is the record with the diesel price (completeness wins over recency here).
    expect(result[0].id).toBe('TyVGrppSLdVuEl3mGLQi');
    expect(result[0].dieselPriceChf).toBe(2.07);
    // Dedup decisions are logged for observability.
    expect(logger).toHaveBeenCalled();
    const logged = logger.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(logged).toMatch(/merged 1 duplicate/);
    expect(logged).toMatch(/TyVGrppSLdVuEl3mGLQi/);
    expect(logged).toMatch(/feGaE8DvyVQLWX2KWvCM/);
  });

  it('breaks ties with most-recent updatedAt when completeness is equal', () => {
    const input = [
      {
        id: 'old',
        name: 'Eni',
        brand: 'ENI',
        address: 'Via Cantonale 36, 6987 Caslano',
        sp95PriceChf: 1.78,
        dieselPriceChf: 2.07,
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 'new',
        name: 'Eni',
        brand: 'ENI',
        address: 'Via Cantonale 36, 6987 Caslano',
        sp95PriceChf: 1.79,
        dieselPriceChf: 2.08,
        updatedAt: '2026-04-20T00:00:00.000Z',
      },
    ];
    const result = dedupFuelStations(input, { logger: () => {} });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('new');
  });

  it('keeps distinct stations in the same municipality', () => {
    const input = [
      { id: 's1', name: 'Eni', brand: 'ENI', address: 'Via Cantonale 36, 6987 Caslano' },
      { id: 's2', name: 'ECSA Energy SA - Caslano', brand: '', address: 'Via Colombera 10, 6987 Caslano' },
      { id: 's3', name: 'Texon Service', brand: '', address: 'Via Cantonale 50, 6987 Caslano' },
    ];
    const result = dedupFuelStations(input, { logger: () => {} });
    expect(result).toHaveLength(3);
  });

  it('is stable: preserves first-seen order', () => {
    const input = [
      { id: 'first', name: 'Eni', brand: 'ENI', address: 'Via Cantonale 36, 6987 Caslano' },
      { id: 'second', name: 'BP', brand: 'BP', address: 'Via Foo 1, 6830 Chiasso' },
      { id: 'third', name: 'Eni', brand: 'ENI', address: 'Via Cantonale 36, 6987 Caslano' },
    ];
    const result = dedupFuelStations(input, { logger: () => {} });
    expect(result.map((s: { id: string }) => s.id)).toEqual(['first', 'second']);
  });

  it('tolerates non-array and malformed input gracefully', () => {
    expect(dedupFuelStations(null, { logger: () => {} })).toEqual([]);
    expect(dedupFuelStations(undefined, { logger: () => {} })).toEqual([]);
    const mixed = [null, undefined, 'string', { id: 'ok', name: 'Eni', brand: 'ENI', address: 'A' }];
    const result = dedupFuelStations(mixed, { logger: () => {} });
    expect(result).toHaveLength(1);
  });
});

describe('fuelDailyPages plugin-level dedup (defense in depth)', () => {
  it('emits only ONE per-station page for two Eni Caslano records with distinct ids', () => {
    const dataset = {
      generatedAt: '2026-04-20T06:00:00.000Z',
      municipalities: [
        {
          municipality: 'Lavena Ponte Tresa',
          province: 'VA',
          swiss: {
            nearbyStations: [
              {
                id: 'TyVGrppSLdVuEl3mGLQi',
                name: 'Eni',
                brand: 'ENI',
                address: 'Via Cantonale 36, 6987 Caslano',
                lat: 45.97394481908457,
                lng: 8.869804789687063,
                sp95PriceChf: 1.78,
                dieselPriceChf: 2.07,
                dieselSource: 'api' as const,
                updatedAt: '2026-04-18T13:43:03.407Z',
              },
              {
                id: 'feGaE8DvyVQLWX2KWvCM',
                name: 'Eni',
                brand: 'ENI',
                address: 'Via Cantonale 36, 6987 Caslano',
                lat: 45.97979876673632,
                lng: 8.877340395031382,
                sp95PriceChf: 1.79,
                dieselPriceChf: 2.08,
                dieselSource: 'api' as const,
                updatedAt: '2026-04-10T09:00:00.000Z',
              },
            ],
          },
        },
      ],
    };

    const pages = generateFuelStationPages({ dataset, distDir: '/tmp/test-dist-dedup' });
    const paths = Object.keys(pages);
    // IT locale pages live under the root (no /en/, /de/, /fr/ prefix).
    const italianDieselPages = paths.filter(
      (p) =>
        p.includes('/prezzi-diesel/') &&
        p.includes(`/${FUEL_STATIONS_SLUG.it}/`) &&
        !/^\/(en|de|fr)\//.test(p),
    );
    // Before the fix: 2 pages (`.../eni-via-cantonale/` + `.../eni-via-cantonale-2/`).
    // After the fix: exactly 1 page for the physical Eni Caslano station.
    expect(italianDieselPages).toHaveLength(1);
    // No numeric-disambiguation slug (`-2`, `-3`, …) should ever appear for
    // this station — the dedup key collapses coord drift upstream.
    expect(paths.some((p) => /eni-[a-z-]+-\d+\/?$/.test(p))).toBe(false);
  });
});
