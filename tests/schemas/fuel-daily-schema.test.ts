// tests/schemas/fuel-daily-schema.test.ts
//
// Real shape confirmed from data/fuel-prices-history/YYYY-MM-DD.json.
// The task spec assumed a flat fuelType/countryAvgChf/pricesByCanton shape —
// actual data uses zones (per Ticino zone), regional averages, diesel coverage
// stats, optional italianCities, and optional per-station prices.
import { describe, it, expect } from 'vitest';
import {
  FuelDailySnapshotSchema,
  ValidatedFuelDailySnapshotSchema,
} from '../../scripts/lib/schemas/fuelDaily.mjs';

const validZones = {
  chiasso: { diesel: 2.204, benzina: 1.886 },
  mendrisio: { diesel: 2.193, benzina: 1.817 },
  lugano: { diesel: 2.187, benzina: 1.9 },
  bellinzona: { diesel: 2.212, benzina: 1.984 },
  locarno: { diesel: 2.01, benzina: 1.845 },
};

const valid = {
  date: '2026-05-20',
  generatedAt: '2026-05-20T06:00:00.000Z',
  zones: validZones,
  regional: { diesel: 2.149, benzina: 1.874 },
  diesel: {
    source: 'mixed',
    realCoveragePct: 91.1,
    realStationCount: 92,
    totalStationCount: 101,
  },
};

describe('FuelDailySnapshotSchema', () => {
  it('accepts a valid snapshot (minimal — no italianCities, no stations)', () => {
    const r = FuelDailySnapshotSchema.safeParse(valid);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('accepts a full snapshot with italianCities and stations', () => {
    const full = {
      ...valid,
      italianCities: {
        como: { benzina: 1.72, stationCount: 8 },
        varese: { benzina: null, stationCount: 0 },
      },
      stations: {
        'pemoil-corso-san-gottardo': { diesel: 2.19, benzina: 1.88 },
        'silo-via-emilio-bossi': { benzina: 1.87 },
      },
    };
    expect(FuelDailySnapshotSchema.safeParse(full).success).toBe(true);
  });

  it('rejects malformed date', () => {
    expect(
      FuelDailySnapshotSchema.safeParse({ ...valid, date: '20/05/2026' }).success,
    ).toBe(false);
  });

  it('rejects negative regional average (ValidatedFuelDailySnapshotSchema)', () => {
    expect(
      ValidatedFuelDailySnapshotSchema.safeParse({
        ...valid,
        regional: { diesel: -1, benzina: 1.874 },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown diesel source', () => {
    expect(
      FuelDailySnapshotSchema.safeParse({
        ...valid,
        diesel: { ...valid.diesel, source: 'unknown-src' },
      }).success,
    ).toBe(false);
  });

  it('rejects missing zones', () => {
    const { zones, ...withoutZones } = valid;
    expect(FuelDailySnapshotSchema.safeParse(withoutZones).success).toBe(false);
  });

  it('rejects missing regional', () => {
    const { regional, ...withoutRegional } = valid;
    expect(FuelDailySnapshotSchema.safeParse(withoutRegional).success).toBe(false);
  });
});
