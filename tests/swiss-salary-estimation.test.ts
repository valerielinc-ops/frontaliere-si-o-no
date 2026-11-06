/**
 * Canton-aware salary estimation.
 *
 * estimateSwissSalary scales the Ticino USTAT sector structure to a job's
 * canton via the official BFS Grossregion wage factor. estimateTicinoSalary is
 * the legacy TI-pinned wrapper and must stay byte-identical to the Ticino
 * branch of estimateSwissSalary.
 */
import { describe, it, expect } from 'vitest';

import { estimateSwissSalary, estimateTicinoSalary } from '../scripts/lib/salary-estimation.mjs';

const SWE = { title: 'Software Engineer', category: 'tech' };

describe('estimateSwissSalary — canton scaling', () => {
  it('Ticino branch is byte-identical to the legacy estimateTicinoSalary', () => {
    const ti = estimateSwissSalary({ ...SWE, canton: 'TI' });
    const legacy = estimateTicinoSalary(SWE);
    expect(legacy.minValue).toBe(ti.minValue);
    expect(legacy.maxValue).toBe(ti.maxValue);
    expect(legacy.level).toBe(ti.level);
    expect(legacy.sectorName).toBe(ti.sectorName);
    expect(ti.cantonFactor).toBe(1);
  });

  it('estimateTicinoSalary ignores job.canton (always Ticino)', () => {
    const a = estimateTicinoSalary({ ...SWE, canton: 'ZH' });
    const b = estimateTicinoSalary({ ...SWE, canton: 'TI' });
    expect(a).toEqual(b);
  });

  it('Zürich pays more than Ticino for the same role', () => {
    const zh = estimateSwissSalary({ ...SWE, canton: 'ZH' });
    const ti = estimateSwissSalary({ ...SWE, canton: 'TI' });
    expect(zh.minValue).toBeGreaterThan(ti.minValue);
    expect(zh.maxValue).toBeGreaterThan(ti.maxValue);
    expect(zh.cantonFactor).toBeGreaterThan(1.3);
  });

  it('Ostschweiz (lower wage region) sits between Ticino and Zürich', () => {
    const ti = estimateSwissSalary({ ...SWE, canton: 'TI' }).maxValue;
    const sg = estimateSwissSalary({ ...SWE, canton: 'SG' }).maxValue;
    const zh = estimateSwissSalary({ ...SWE, canton: 'ZH' }).maxValue;
    expect(sg).toBeGreaterThan(ti);
    expect(sg).toBeLessThan(zh);
  });

  it('applies the frontalieri discount only to border cantons', () => {
    // Geneva is a border canton → discount applied for a discounted sector.
    const ge = estimateSwissSalary({ ...SWE, canton: 'GE' });
    expect(ge.frontialieriAdjusted).toBe(true);
    // Zürich is an interior canton → no frontalieri discount.
    const zh = estimateSwissSalary({ ...SWE, canton: 'ZH' });
    expect(zh.frontialieriAdjusted).toBe(false);
  });

  it('honours the cantonal statutory minimum wage floor (Geneva)', () => {
    // A low-paid sector in Geneva is floored at the GE statutory minimum.
    const ge = estimateSwissSalary({
      title: 'Addetto pulizie',
      category: 'cleaning',
      canton: 'GE',
    });
    expect(ge.minValue).toBeGreaterThanOrEqual(51100);
  });

  it('defaults missing canton to Ticino', () => {
    const noCanton = estimateSwissSalary(SWE);
    const ti = estimateSwissSalary({ ...SWE, canton: 'TI' });
    expect(noCanton.minValue).toBe(ti.minValue);
    expect(noCanton.maxValue).toBe(ti.maxValue);
  });
});
