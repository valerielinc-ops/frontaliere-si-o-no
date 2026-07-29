/**
 * Unit coverage for the shared scripts/lib/municipality-plausibility-guard.mjs
 * (issue #4886 range guard; distribution guard added issue #4922).
 *
 * Dedicated unit-level file, separate from the per-dataset coherence tests
 * (e.g. tests/fiscal-municipalities-dataset.test.ts) which exercise the
 * guard against the LIVE data — this file only exercises the guard
 * function itself against small synthetic fixtures, so a guard-logic
 * regression fails here directly instead of being inferred from a dataset
 * test failing for an unrelated reason.
 */

import { describe, expect, it } from 'vitest';

import {
  assertPlausibleMunicipality,
  assertPlausibleDistribution,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
  MIN_PLAUSIBLE_DISTANCE_KM,
  MAX_PLAUSIBLE_DISTANCE_KM,
  DEFAULT_MAX_VALUE_SHARE,
} from '../scripts/lib/municipality-plausibility-guard.mjs';

function makeMunicipality(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Test Comune',
    province: 'CO',
    population: 5000,
    distanceKm: 10,
    ...overrides,
  };
}

describe('assertPlausibleMunicipality — range check', () => {
  it('does not throw for a plausible population and distance', () => {
    expect(() => assertPlausibleMunicipality(makeMunicipality())).not.toThrow();
  });

  it('throws on population below MIN_PLAUSIBLE_POPULATION (e.g. a stray 0)', () => {
    expect(() => assertPlausibleMunicipality(makeMunicipality({ population: 0 }))).toThrow(
      /implausible population/,
    );
  });

  it('throws on population above MAX_PLAUSIBLE_POPULATION (transcription typo, extra digit)', () => {
    expect(() =>
      assertPlausibleMunicipality(makeMunicipality({ population: MAX_PLAUSIBLE_POPULATION + 1 })),
    ).toThrow(/implausible population/);
  });

  it('accepts the real documented minimum (Cervatto, VC — population 47)', () => {
    expect(MIN_PLAUSIBLE_POPULATION).toBeLessThanOrEqual(47);
    expect(() => assertPlausibleMunicipality(makeMunicipality({ population: 47 }))).not.toThrow();
  });

  it('throws on an out-of-range distanceKm', () => {
    expect(() =>
      assertPlausibleMunicipality(makeMunicipality({ distanceKm: MAX_PLAUSIBLE_DISTANCE_KM + 1 })),
    ).toThrow(/implausible distanceKm/);
  });

  it('leaves non-finite values to the caller (not this guard\'s job)', () => {
    expect(() => assertPlausibleMunicipality(makeMunicipality({ population: Number.NaN }))).not.toThrow();
    expect(() =>
      assertPlausibleMunicipality(makeMunicipality({ distanceKm: undefined })),
    ).not.toThrow();
  });

  it('includes the sourceLabel and municipality name in the thrown message', () => {
    expect(() =>
      assertPlausibleMunicipality(makeMunicipality({ name: 'Frazione Fittizia', population: -5 }), {
        sourceLabel: 'unit-test',
      }),
    ).toThrow(/\[unit-test\].*Frazione Fittizia/);
  });

  it('MIN_PLAUSIBLE_DISTANCE_KM stays a real lower bound (0)', () => {
    expect(MIN_PLAUSIBLE_DISTANCE_KM).toBe(0);
  });
});

describe('assertPlausibleDistribution — repeated-placeholder guard (issue #4922)', () => {
  function repeatedValueDataset(total: number, repeatedShare: number, repeatedValue: number) {
    const repeatedCount = Math.round(total * repeatedShare);
    const rows = [];
    for (let i = 0; i < repeatedCount; i++) {
      rows.push(makeMunicipality({ name: `Repeated ${i}`, population: repeatedValue }));
    }
    // Fill the rest with distinct, non-repeating values so only the
    // deliberately-repeated value could trip the guard.
    for (let i = repeatedCount; i < total; i++) {
      rows.push(makeMunicipality({ name: `Distinct ${i}`, population: 1000 + i }));
    }
    return rows;
  }

  it('FAILS on a synthetic dataset that repeats one population value beyond the threshold — proves the protection works', () => {
    // Mirrors the real defect this guard was written for: population: 2000
    // covering 417/518 (80%) of data/municipalities.ts before issue #4922.
    const synthetic = repeatedValueDataset(40, 0.8, 2000);
    expect(() =>
      assertPlausibleDistribution(synthetic, { field: 'population', sourceLabel: 'unit-test' }),
    ).toThrow(/implausible distribution/);
    expect(() =>
      assertPlausibleDistribution(synthetic, { field: 'population', sourceLabel: 'unit-test' }),
    ).toThrow(/population=2000/);
    expect(() =>
      assertPlausibleDistribution(synthetic, { field: 'population', sourceLabel: 'unit-test' }),
    ).toThrow(/32\/40/); // 80% of 40 rows = 32
  });

  it('does not throw when no single value exceeds the share threshold', () => {
    const synthetic = repeatedValueDataset(40, 0.1, 2000); // 10% share, under the default 25%
    expect(() =>
      assertPlausibleDistribution(synthetic, { field: 'population', sourceLabel: 'unit-test' }),
    ).not.toThrow();
  });

  it('respects a custom maxShare override', () => {
    const synthetic = repeatedValueDataset(40, 0.3, 2000); // 30% share
    // Under the default 25% threshold this must throw...
    expect(() => assertPlausibleDistribution(synthetic, { field: 'population' })).toThrow();
    // ...but passes against a looser, explicitly-widened threshold.
    expect(() =>
      assertPlausibleDistribution(synthetic, { field: 'population', maxShare: 0.5 }),
    ).not.toThrow();
  });

  it('is a no-op below minSampleSize — a handful of identical small-dataset rows is not evidence of a placeholder', () => {
    const tiny = repeatedValueDataset(5, 1, 2000); // 100% identical, but only 5 rows
    expect(() =>
      assertPlausibleDistribution(tiny, { field: 'population', sourceLabel: 'unit-test' }),
    ).not.toThrow();
  });

  it('requires an explicit field option', () => {
    expect(() => assertPlausibleDistribution([makeMunicipality()])).toThrow(/field.*required/);
  });

  it('DEFAULT_MAX_VALUE_SHARE sits inside the issue-suggested 20-30% band', () => {
    expect(DEFAULT_MAX_VALUE_SHARE).toBeGreaterThanOrEqual(0.2);
    expect(DEFAULT_MAX_VALUE_SHARE).toBeLessThanOrEqual(0.3);
  });
});
