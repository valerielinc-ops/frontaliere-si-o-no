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
} from '@/build-plugins/shared/cantonSalaryIndex';
import {
  getCantonSalaryFactor,
  isBorderCanton,
} from '../scripts/lib/swiss-canton-salary.mjs';

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
