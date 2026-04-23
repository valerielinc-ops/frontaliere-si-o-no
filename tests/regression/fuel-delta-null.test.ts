/**
 * Regression: fuel computeDeltaVsYesterday null propagation
 *
 * Before the fix, the inline delta computation in fuelDailyPagesPlugin rendered
 * `0` (formatted as "0,000 CHF") when either today's price or yesterday's
 * snapshot was missing, rather than "—".
 *
 * The fix extracted the logic into a named export
 * `computeDeltaVsYesterday(todayAvg, yesterdayAvg): number | null`
 * in build-plugins/fuelDailyData.ts. This suite ensures the exported function
 * behaves correctly for all null/missing inputs and for the zero-delta edge case.
 */

import { describe, it, expect } from 'vitest';
import { computeDeltaVsYesterday } from '../../build-plugins/fuelDailyData';

describe('computeDeltaVsYesterday — null propagation', () => {
  it('returns null when todayAvg is null', () => {
    expect(computeDeltaVsYesterday(null, 2.0)).toBeNull();
  });

  it('returns null when yesterdayAvg is null', () => {
    expect(computeDeltaVsYesterday(2.0, null)).toBeNull();
  });

  it('returns null when both inputs are null', () => {
    expect(computeDeltaVsYesterday(null, null)).toBeNull();
  });
});

describe('computeDeltaVsYesterday — numeric results', () => {
  it('returns approximately 0.1 for (2.1, 2.0)', () => {
    const result = computeDeltaVsYesterday(2.1, 2.0);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.1, 3);
  });

  it('returns 0 for (2.0, 2.0) — genuine zero delta distinct from null', () => {
    const result = computeDeltaVsYesterday(2.0, 2.0);
    expect(result).not.toBeNull();
    expect(result).toBe(0);
  });

  it('returns a negative delta when today is lower than yesterday', () => {
    const result = computeDeltaVsYesterday(1.95, 2.0);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(-0.05, 3);
  });

  it('result is rounded to 3 decimal places', () => {
    // 2.1234 - 2.0 = 0.1234 → rounded to 0.123
    const result = computeDeltaVsYesterday(2.1234, 2.0);
    expect(result).not.toBeNull();
    // toFixed(3) rounds 0.1234 → "0.123"
    expect(result).toBe(0.123);
  });
});
