/**
 * Ticino municipal multiplier adjustment (issue #4470).
 *
 * The CH-resident net must move with the chosen comune's `moltiplicatore
 * comunale`: a higher-than-baseline multiplier means more tax (lower net), a
 * lower one means less tax (higher net), and the cantonal-average baseline
 * leaves the figure untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  ticinoMunicipalTaxDeltaCHF,
  applyTicinoMunicipalMultiplier,
} from '@/services/calculationService';
import municipalData from '@/data/ticino-municipal-multipliers.json';

const BASELINE = 78;
const BASE_TAX = 12000; // annual Ticino income tax at cantonal-average multiplier

describe('ticinoMunicipalTaxDeltaCHF', () => {
  it('is zero at the baseline multiplier', () => {
    expect(ticinoMunicipalTaxDeltaCHF(BASE_TAX, BASELINE, BASELINE)).toBe(0);
  });

  it('is positive (more tax) above the baseline', () => {
    const delta = ticinoMunicipalTaxDeltaCHF(BASE_TAX, 100, BASELINE);
    expect(delta).toBeGreaterThan(0);
    // base × (100 − 78) / (100 + 78) = 12000 × 22 / 178 ≈ 1483
    expect(delta).toBeCloseTo((BASE_TAX * 22) / 178, 2);
  });

  it('is negative (less tax) below the baseline', () => {
    const delta = ticinoMunicipalTaxDeltaCHF(BASE_TAX, 65, BASELINE);
    expect(delta).toBeLessThan(0);
    expect(delta).toBeCloseTo((BASE_TAX * -13) / 178, 2);
  });

  it('monotonically increases with the multiplier', () => {
    const low = ticinoMunicipalTaxDeltaCHF(BASE_TAX, 65, BASELINE);
    const mid = ticinoMunicipalTaxDeltaCHF(BASE_TAX, 85, BASELINE);
    const high = ticinoMunicipalTaxDeltaCHF(BASE_TAX, 100, BASELINE);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it('returns 0 for non-positive or non-finite base tax', () => {
    expect(ticinoMunicipalTaxDeltaCHF(0, 100, BASELINE)).toBe(0);
    expect(ticinoMunicipalTaxDeltaCHF(-500, 100, BASELINE)).toBe(0);
    expect(ticinoMunicipalTaxDeltaCHF(Number.NaN, 100, BASELINE)).toBe(0);
  });
});

describe('applyTicinoMunicipalMultiplier', () => {
  it('leaves the tax unchanged at the baseline', () => {
    expect(applyTicinoMunicipalMultiplier(BASE_TAX, BASELINE, BASELINE)).toBe(BASE_TAX);
  });

  it('raises the tax for a high-multiplier comune', () => {
    expect(applyTicinoMunicipalMultiplier(BASE_TAX, 100, BASELINE)).toBeGreaterThan(BASE_TAX);
  });

  it('never returns below zero', () => {
    expect(applyTicinoMunicipalMultiplier(100, 0, 100000)).toBeGreaterThanOrEqual(0);
  });
});

describe('ticino-municipal-multipliers.json data integrity', () => {
  const data = municipalData as {
    referenceYear: number;
    sourceTaxBaselineMultiplierPct: number;
    municipalities: { name: string; multiplierPct: number }[];
  };

  it('declares a reference year and a baseline multiplier', () => {
    expect(data.referenceYear).toBeGreaterThan(2020);
    expect(data.sourceTaxBaselineMultiplierPct).toBeGreaterThan(0);
  });

  it('lists real municipalities with plausible multipliers', () => {
    expect(data.municipalities.length).toBeGreaterThanOrEqual(10);
    for (const m of data.municipalities) {
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      // TI municipal multipliers realistically sit between ~50% and ~110%.
      expect(m.multiplierPct).toBeGreaterThanOrEqual(50);
      expect(m.multiplierPct).toBeLessThanOrEqual(110);
    }
  });

  it('has unique municipality names', () => {
    const names = data.municipalities.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
