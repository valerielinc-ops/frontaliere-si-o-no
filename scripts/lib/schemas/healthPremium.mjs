// scripts/lib/schemas/healthPremium.mjs
//
// NOTE: The plan described a flat per-row schema
// (canton, region, ageGroup, accidentCover, insurer, product, monthlyPremiumChf, year).
// Real data produced by scripts/fetch-health-premiums.mjs uses a DIFFERENT structure:
//   premiums[communeKey or cantonCode] = {
//     canton, region (int|null), bfsNr (optional), type? ('canton'),
//     insurers: { [insurerId]: { standard?, hausarzt?, hmo?, telmed?, byAgeClass: { KIN?, JUG?, ERW? } } }
//   }
// This schema validates each entry in the `premiums` dict (one per commune/canton).
// Schema adapted to match the real stored shape; plan's flat-row model does not apply here.

import { z } from 'zod';

// Standard 26 Swiss canton codes plus ZE/ZR which appear in BAG CSV output
// (observed in all years 2024-2026; likely non-standard BAG territory segments).
const CantonSchema = z.enum([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU',
  'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
  'ZE', 'ZR', // BAG non-standard codes present in real data across all years
]);

// Per-model premium values for one age class. At least one model must be present.
// Models: standard (TAR-BASE), hausarzt (HAM), hmo (HMO), telmed (DIV/alternative).
const PremiumModelsSchema = z.object({
  standard: z.number().positive().optional(),
  hausarzt: z.number().positive().optional(),
  hmo: z.number().positive().optional(),
  telmed: z.number().positive().optional(),
}).refine(
  (m) => m.standard !== undefined || m.hausarzt !== undefined || m.hmo !== undefined || m.telmed !== undefined,
  { message: 'at-least-one-model-required' },
);

// byAgeClass block: KIN (0-18), JUG (19-25), ERW (26+) — at least one must be present.
const ByAgeClassSchema = z.object({
  KIN: PremiumModelsSchema.optional(),
  JUG: PremiumModelsSchema.optional(),
  ERW: PremiumModelsSchema.optional(),
}).refine(
  (bac) => bac.KIN !== undefined || bac.JUG !== undefined || bac.ERW !== undefined,
  { message: 'byAgeClass-must-have-at-least-one-age-class' },
);

// One insurer's entry inside a premium record.
// Top-level standard/hausarzt/hmo/telmed are back-compat aliases for ERW values.
// byAgeClass is the authoritative per-age-class breakdown.
const InsurerEntrySchema = z.object({
  standard: z.number().positive().optional(),
  hausarzt: z.number().positive().optional(),
  hmo: z.number().positive().optional(),
  telmed: z.number().positive().optional(),
  byAgeClass: ByAgeClassSchema,
}).passthrough();

// The insurers dict: keys are numeric insurer IDs (stored as strings in JSON).
const InsurersMapSchema = z.record(z.string().regex(/^\d+$/, 'insurer-id-must-be-numeric'), InsurerEntrySchema);

// One premium entry in the output `premiums` dict.
// Commune entries: canton is a 2-letter code, region is a positive int, bfsNr is an int.
// Canton entries: type === 'canton', region === null, no bfsNr.
export const HealthPremiumRowSchema = z.object({
  canton: CantonSchema,
  region: z.union([z.number().int().positive(), z.null()]),
  bfsNr: z.number().int().positive().optional(),       // commune entries only
  type: z.literal('canton').optional(),                 // canton entries only
  insurers: InsurersMapSchema,
}).passthrough();

// Validate the top-level structure of a health-premiums JSON file.
export const HealthPremiumFileSchema = z.object({
  fetchedAt: z.string().datetime(),
  year: z.number().int().min(2024).max(2030),
  insurers: z.array(z.object({
    id: z.string().regex(/^\d+$/),
    name: z.string().min(1),
    website: z.string().url().optional().or(z.literal('')),
  })),
  communes: z.record(z.string(), z.array(z.object({
    name: z.string().min(1),
    bfsNr: z.number().int().positive(),
    plz: z.union([z.number(), z.string()]),
    region: z.number().int(),
  }))).optional(),
  premiums: z.record(z.string(), HealthPremiumRowSchema),
  rankings: z.object({
    cheapest: z.array(z.any()),
    mostExpensive: z.array(z.any()),
  }),
}).passthrough();
