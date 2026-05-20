// scripts/lib/schemas/fuelDaily.mjs
//
// Schema for data/fuel-prices-history/YYYY-MM-DD.json snapshots emitted by
// scripts/snapshot-fuel-history.mjs.
//
// Shape diverges from the task spec's assumed flat fuelType/countryAvgChf
// structure. Actual data uses per-zone Ticino averages, regional averages,
// diesel coverage diagnostics, and (from 2026-04-25) per-Italian-city
// averages. Per-station prices added 2026-05-18.
import { z } from 'zod';

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date-not-iso');
const IsoDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T/, 'datetime-not-iso');

// A zone entry. Both fields may be null when no stations cover the zone.
const ZoneEntrySchema = z.object({
  diesel: z.number().nullable(),
  benzina: z.number().nullable(),
});

// Per-canton / per-zone price map. At minimum the five Ticino zones are
// present: chiasso, mendrisio, lugano, bellinzona, locarno.
const ZonesSchema = z.record(z.string(), ZoneEntrySchema);

// Regional (Switzerland-wide) averages across all TCS stations.
const RegionalSchema = z.object({
  diesel: z.number().nullable(),
  benzina: z.number().nullable(),
});

// Diesel coverage diagnostics — helps audit real vs derived prices day by day.
const DieselCoverageSchema = z.object({
  source: z.enum(['api', 'derived', 'mixed']),
  realCoveragePct: z.number().min(0).max(100),
  realStationCount: z.number().int().min(0),
  totalStationCount: z.number().int().min(0),
});

// Per-Italian-city averages (benzina only; stationCount=0 when no data).
// Added from snapshot dated 2026-04-25 onward.
const ItalianCityEntrySchema = z.object({
  benzina: z.number().nullable(),
  stationCount: z.number().int().min(0),
});

const ItalianCitiesSchema = z.record(z.string(), ItalianCityEntrySchema);

// Per-station prices keyed by slug (buildStationSlug output).
// Added from snapshot dated 2026-05-18 onward.
const StationEntrySchema = z
  .object({
    diesel: z.number().positive().optional(),
    benzina: z.number().positive().optional(),
  })
  .refine((v) => v.diesel !== undefined || v.benzina !== undefined, {
    message: 'station-entry-must-have-at-least-one-price',
  });

const StationsSchema = z.record(z.string(), StationEntrySchema);

export const FuelDailySnapshotSchema = z
  .object({
    date: IsoDateSchema,
    generatedAt: IsoDateTimeSchema,
    zones: ZonesSchema,
    regional: RegionalSchema,
    diesel: DieselCoverageSchema,
    // Optional — absent in oldest snapshots (pre 2026-04-25)
    italianCities: ItalianCitiesSchema.optional(),
    // Optional — absent in snapshots before 2026-05-18
    stations: StationsSchema.optional(),
  })
  .passthrough();

// Regional prices must be non-negative when present (null is allowed for
// missing data; negative prices are a data error).
// Applied as a separate refinement to give a clear error message.
export const ValidatedFuelDailySnapshotSchema = FuelDailySnapshotSchema.refine(
  (v) => {
    const { diesel, benzina } = v.regional;
    if (diesel !== null && diesel < 0) return false;
    if (benzina !== null && benzina < 0) return false;
    return true;
  },
  { message: 'regional-price-must-be-non-negative' },
);
