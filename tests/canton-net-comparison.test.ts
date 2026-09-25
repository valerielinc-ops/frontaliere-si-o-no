/**
 * Multi-canton net comparison estimator (issue #4471).
 *
 * `estimateCantonNetMonthly` rescales the user's Ticino gross to a target
 * canton's wage level (BFS) and applies that canton's tax burden (ESTV). The
 * output must be a positive, plausible monthly net, higher-wage cantons must
 * scale the gross up, and unusable input must return null (never fabricate).
 */
import { describe, it, expect } from 'vitest';
import {
  estimateCantonNetMonthly,
  CANTON_COMPARISON_DEFAULTS,
} from '@/services/cantonSalary';

const GROSS = 90000;

describe('estimateCantonNetMonthly', () => {
  it('returns null for non-positive / unusable gross', () => {
    expect(estimateCantonNetMonthly(0, 'ZH')).toBeNull();
    expect(estimateCantonNetMonthly(-1000, 'ZH')).toBeNull();
    expect(estimateCantonNetMonthly(Number.NaN, 'ZH')).toBeNull();
    expect(estimateCantonNetMonthly(GROSS, '')).toBeNull();
  });

  it('produces a positive monthly net below the gross monthly', () => {
    const est = estimateCantonNetMonthly(GROSS, 'ZH', 'TI');
    expect(est).not.toBeNull();
    expect(est!.netMonthlyCHF).toBeGreaterThan(0);
    // Net is always below the (scaled) gross monthly.
    expect(est!.netMonthlyCHF).toBeLessThan(est!.grossAnnualCHF / 12);
  });

  it('scales the gross UP for a higher-wage canton than Ticino', () => {
    // Zurich's grossregion median is well above Ticino's, so the same-role
    // gross rescales upward.
    const zh = estimateCantonNetMonthly(GROSS, 'ZH', 'TI');
    expect(zh!.grossAnnualCHF).toBeGreaterThan(GROSS);
  });

  it('returns the canton code it was asked for (uppercased)', () => {
    const est = estimateCantonNetMonthly(GROSS, 'ge', 'TI');
    expect(est!.canton).toBe('GE');
  });

  it('all default comparison cantons produce a usable estimate', () => {
    for (const code of CANTON_COMPARISON_DEFAULTS) {
      const est = estimateCantonNetMonthly(GROSS, code, 'TI');
      expect(est, `estimate for ${code}`).not.toBeNull();
      expect(est!.netMonthlyCHF).toBeGreaterThan(1000);
    }
  });

  it('excludes Ticino from the default comparison set to avoid a self-row', () => {
    expect(CANTON_COMPARISON_DEFAULTS).not.toContain('TI');
    expect(CANTON_COMPARISON_DEFAULTS.length).toBeGreaterThanOrEqual(3);
    expect(CANTON_COMPARISON_DEFAULTS.length).toBeLessThanOrEqual(5);
  });
});
