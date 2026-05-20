// tests/schemas/health-premium-schema.test.ts
//
// NOTE: Real data from fetch-health-premiums.mjs uses a nested commune/canton
// structure — NOT the flat per-row shape described in the plan. Schema has been
// adapted to match actual stored data. See scripts/lib/schemas/healthPremium.mjs
// for full deviation notes.

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs schema module, no type declarations
import { HealthPremiumRowSchema, HealthPremiumFileSchema } from '../../scripts/lib/schemas/healthPremium.mjs';

// A valid commune entry (matching real data shape from data/health-premiums/2026.json)
const validCommuneEntry = {
  canton: 'TI',
  region: 1,
  bfsNr: 5001,
  insurers: {
    '8': {
      hausarzt: 577.8,
      telmed: 633.1,
      standard: 691.9,
      byAgeClass: {
        KIN: { hausarzt: 132.9, telmed: 139.3, standard: 152.2 },
        JUG: { hausarzt: 404.4, telmed: 474.8, standard: 518.9 },
        ERW: { hausarzt: 577.8, telmed: 633.1, standard: 691.9 },
      },
    },
  },
};

// A valid canton-level entry (no bfsNr, region is null, type === 'canton')
const validCantonEntry = {
  type: 'canton' as const,
  canton: 'AG',
  region: null,
  insurers: {
    '8': {
      hausarzt: 452.9,
      telmed: 476.5,
      standard: 523.6,
      byAgeClass: {
        KIN: { hausarzt: 99.6, standard: 115.2 },
        ERW: { hausarzt: 452.9, standard: 523.6 },
      },
    },
  },
};

describe('HealthPremiumRowSchema (commune entry)', () => {
  it('accepts a valid commune entry', () => {
    const r = HealthPremiumRowSchema.safeParse(validCommuneEntry);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('accepts a valid canton entry', () => {
    const r = HealthPremiumRowSchema.safeParse(validCantonEntry);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('rejects unknown canton code', () => {
    const bad = { ...validCommuneEntry, canton: 'XX' };
    expect(HealthPremiumRowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative premium in insurer entry', () => {
    const bad = {
      ...validCommuneEntry,
      insurers: {
        '8': {
          standard: -10,
          byAgeClass: { ERW: { standard: -10 } },
        },
      },
    };
    expect(HealthPremiumRowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects insurer entry with no models at all', () => {
    const bad = {
      ...validCommuneEntry,
      insurers: {
        '8': {
          byAgeClass: { ERW: {} }, // ERW has no models
        },
      },
    };
    expect(HealthPremiumRowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects insurer entry with byAgeClass missing entirely', () => {
    const bad = {
      ...validCommuneEntry,
      insurers: {
        '8': { standard: 500 }, // missing byAgeClass
      },
    };
    expect(HealthPremiumRowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-numeric insurer ID key', () => {
    const bad = {
      ...validCommuneEntry,
      insurers: {
        'CSS': { standard: 500, byAgeClass: { ERW: { standard: 500 } } },
      },
    };
    expect(HealthPremiumRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe('HealthPremiumFileSchema', () => {
  it('accepts a minimal valid file structure', () => {
    const file = {
      fetchedAt: '2026-05-17T07:15:39.961Z',
      year: 2026,
      insurers: [{ id: '8', name: 'CSS', website: 'https://www.css.ch' }],
      premiums: { 'TI': validCantonEntry },
      rankings: { cheapest: [], mostExpensive: [] },
    };
    const r = HealthPremiumFileSchema.safeParse(file);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range year', () => {
    const file = {
      fetchedAt: '2026-05-17T07:15:39.961Z',
      year: 1990,
      insurers: [],
      premiums: {},
      rankings: { cheapest: [], mostExpensive: [] },
    };
    expect(HealthPremiumFileSchema.safeParse(file).success).toBe(false);
  });
});
