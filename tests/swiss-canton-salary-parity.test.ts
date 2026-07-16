/**
 * Drift guard for the per-canton salary index.
 *
 * The canonical data lives in data/swiss-canton-salary-index.json and is read
 * directly by the .mjs estimation pipeline. The .ts build/SEO side mirrors the
 * same numbers as inline literals (build-plugins/shared/cantonSalaryIndex.ts)
 * because the Vite config graph cannot safely import JSON at config-eval time.
 *
 * This test locks the TS literals AND the .mjs accessors to the JSON, so the
 * two copies can never drift (CLAUDE.md rule #6: a constant duplicated across
 * modules must be locked — here by a guard test, since the .mjs/.ts module
 * boundary prevents a single shared import).
 */
import { describe, it, expect } from 'vitest';

import json from '../data/swiss-canton-salary-index.json';
import taxBurdenJson from '../data/swiss-canton-tax-burden.json';
import {
  GROSSREGION_MEDIAN_MONTHLY,
  CANTON_TO_GROSSREGION,
  BORDER_CANTONS,
  STATUTORY_MIN_WAGE_ANNUAL,
  UNIVERSAL_FLOOR_ANNUAL,
  NATIONAL_SECTOR_GAV_FLOOR_ANNUAL,
  TICINO_MEDIAN_MONTHLY,
  NATIONAL_MEDIAN_MONTHLY,
  cantonSalaryFactor,
  TAX_BRACKETS,
  TAX_BURDEN_PCT_BY_CANTON,
  cantonGrossSalaryBand,
  cantonNetSalaryBandForCode,
} from '@/build-plugins/shared/cantonSalaryIndex';
import {
  getCantonSalaryFactor,
  isBorderCanton,
} from '../scripts/lib/swiss-canton-salary.mjs';
import { resolveSalaryBand } from '@/build-plugins/shared/salaryDefaults';

describe('swiss-canton-salary index parity (TS literals === JSON)', () => {
  it('grossregion medians match', () => {
    expect(GROSSREGION_MEDIAN_MONTHLY).toEqual(json.grossregionMedianMonthly);
  });
  it('canton → grossregion mapping matches (all 26 cantons)', () => {
    expect(CANTON_TO_GROSSREGION).toEqual(json.cantonToGrossregion);
    expect(Object.keys(json.cantonToGrossregion)).toHaveLength(26);
  });
  it('border cantons match', () => {
    expect([...BORDER_CANTONS].sort()).toEqual([...json.borderCantons].sort());
  });
  it('statutory minimum wages match', () => {
    expect(STATUTORY_MIN_WAGE_ANNUAL).toEqual(json.statutoryMinWageAnnual);
  });
  it('floors and anchors match', () => {
    expect(UNIVERSAL_FLOOR_ANNUAL).toBe(json.universalFloorAnnual);
    expect(NATIONAL_SECTOR_GAV_FLOOR_ANNUAL).toEqual(json.nationalSectorGavFloorAnnual);
    expect(TICINO_MEDIAN_MONTHLY).toBe(json.ticinoMedianMonthly);
    expect(NATIONAL_MEDIAN_MONTHLY).toBe(json.nationalMedianMonthly);
  });
});

describe('swiss-canton-salary .mjs accessors agree with the .ts twin', () => {
  for (const code of Object.keys(json.cantonToGrossregion)) {
    it(`factor + border flag agree for ${code}`, () => {
      expect(getCantonSalaryFactor(code)).toBeCloseTo(cantonSalaryFactor(code), 10);
      expect(isBorderCanton(code)).toBe(BORDER_CANTONS.has(code));
    });
  }

  it('Ticino factor is exactly 1.0', () => {
    expect(getCantonSalaryFactor('TI')).toBe(1);
    expect(cantonSalaryFactor('TI')).toBe(1);
  });

  it('Zürich factor is the highest (>1.3)', () => {
    expect(cantonSalaryFactor('ZH')).toBeGreaterThan(1.3);
  });

  it('unknown / empty canton defaults to Ticino (factor 1.0)', () => {
    expect(getCantonSalaryFactor('')).toBe(1);
    expect(getCantonSalaryFactor('XX')).toBe(1);
    expect(cantonSalaryFactor(null)).toBe(1);
  });
});

describe('resolveSalaryBand applies the national GAV sector floor (non-TI)', () => {
  // GAV-floored sectors (Construction / Hospitality) under both their IT and EN
  // slugs. The build fallback (.ts) must never emit a non-TI baseSalary below
  // the national GAV floor — mirroring scripts/lib/salary-estimation.mjs's
  // getCantonSectorFloor path so the two estimation paths can't diverge.
  const GAV_SLUGS: Array<[string, keyof typeof NATIONAL_SECTOR_GAV_FLOOR_ANNUAL]> = [
    ['edilizia', 'Construction'],
    ['construction', 'Construction'],
    ['ristorazione', 'Hospitality'],
    ['hospitality', 'Hospitality'],
  ];
  const nonTiCantons = Object.keys(json.cantonToGrossregion).filter((c) => c !== 'TI');

  for (const [slug, sector] of GAV_SLUGS) {
    for (const code of nonTiCantons) {
      it(`${slug} in ${code} never falls below the ${sector} GAV floor`, () => {
        const band = resolveSalaryBand(slug, code);
        expect(band.minValue).toBeGreaterThanOrEqual(NATIONAL_SECTOR_GAV_FLOOR_ANNUAL[sector]);
      });
    }
  }

  it('non-GAV sectors are unaffected (statutory/universal floor only)', () => {
    // 'logistica' carries no GAV floor → floored at the cantonal statutory
    // minimum (or universal), exactly as before the GAV wiring.
    const band = resolveSalaryBand('logistica', 'GE');
    expect(band.minValue).toBeGreaterThanOrEqual(
      STATUTORY_MIN_WAGE_ANNUAL.GE ?? UNIVERSAL_FLOOR_ANNUAL,
    );
  });
});

describe('swiss-canton-tax-burden parity (TS literals === JSON)', () => {
  it('income brackets match', () => {
    expect([...TAX_BRACKETS]).toEqual(taxBurdenJson.incomeBracketsCHF);
  });
  it('per-canton tax burden % match for all 26 cantons', () => {
    expect(TAX_BURDEN_PCT_BY_CANTON).toEqual(taxBurdenJson.totalTaxBurdenPctByCanton);
    expect(Object.keys(taxBurdenJson.totalTaxBurdenPctByCanton)).toHaveLength(26);
  });
});

describe('cantonGrossSalaryBand / cantonNetSalaryBandForCode use real per-canton withholding', () => {
  it('Zug (low-tax) shows a higher net than Geneva (high-tax) at the same gross', () => {
    const zg = cantonNetSalaryBandForCode('ZG', 90000, 110000);
    const ge = cantonNetSalaryBandForCode('GE', 90000, 110000);
    expect(zg.netSingleLow).toBeGreaterThan(ge.netSingleLow);
    expect(zg.netSingleHigh).toBeGreaterThan(ge.netSingleHigh);
  });

  it('an unmapped canton code falls back to the national-average curve (same as no code)', () => {
    expect(cantonNetSalaryBandForCode('XX', 90000, 110000)).toEqual(
      cantonNetSalaryBandForCode(null, 90000, 110000),
    );
  });

  it('the couple figure stays above the single figure (family deduction), for every canton', () => {
    for (const code of Object.keys(taxBurdenJson.totalTaxBurdenPctByCanton)) {
      const band = cantonNetSalaryBandForCode(code, 85000, 110000);
      expect(band.netCoupleLow).toBeGreaterThan(band.netSingleLow);
      expect(band.netCoupleHigh).toBeGreaterThan(band.netSingleHigh);
    }
  });

  it('cantonGrossSalaryBand differentiates net pay by canton display name (previously identical for every canton)', () => {
    const zug = cantonGrossSalaryBand('Zug');
    const geneve = cantonGrossSalaryBand('Genève');
    expect(zug.netSingleLow).not.toBe(geneve.netSingleLow);
  });
});
