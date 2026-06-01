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
  buildDataset,
  buildSwissBorderStations,
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
  });
});
