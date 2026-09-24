/**
 * Regression for issue 9713: the 2026 IRPEF brackets.
 *
 * Legge 30 dicembre 2025 n. 199 (legge di bilancio 2026), art. 1 c. 3, lowered
 * the second IRPEF bracket (€28,000-€50,000) from 35% to 33% starting with tax
 * year 2026. Brackets: 23% up to €28,000, 33% up to €50,000, 43% above.
 * Every case below fails if any bracket still applies 35%.
 */
import { describe, it, expect } from 'vitest';
import { calculateIrpefGross, irpefMarginalRate, IRPEF_BRACKETS_2026 } from '@/services/calculationService';

describe('IRPEF 2026 brackets (L. 199/2025)', () => {
  it('declares 23% / 33% / 43% with thresholds at €28,000 and €50,000', () => {
    expect(IRPEF_BRACKETS_2026.map((b) => [b.upTo, b.rate])).toEqual([
      [28000, 0.23],
      [50000, 0.33],
      [Infinity, 0.43],
    ]);
  });

  it.each([
    // [taxable base EUR, gross IRPEF EUR]
    [20000, 4600], // 20000 * 23%
    [28000, 6440], // 28000 * 23%
    [40000, 10400], // 6440 + 12000 * 33%
    [50000, 13700], // 6440 + 22000 * 33% (was 14140 with 35%)
    [60000, 18000], // 6440 + 7260 + 10000 * 43%
  ])('gross IRPEF on €%i is €%i', (base, expected) => {
    expect(calculateIrpefGross(base)).toBeCloseTo(expected, 6);
  });

  it('saves exactly 2% of the second bracket width (€440) versus the 2025 rates from €50,000 up', () => {
    const rates2025 = (x: number) => Math.min(x, 28000) * 0.23
      + Math.max(0, Math.min(x, 50000) - 28000) * 0.35
      + Math.max(0, x - 50000) * 0.43;
    for (const base of [50000, 60000, 120000]) {
      expect(rates2025(base) - calculateIrpefGross(base)).toBeCloseTo(440, 6);
    }
  });

  it('reports the marginal rate from the same table', () => {
    expect(irpefMarginalRate(20000)).toBe(0.23);
    expect(irpefMarginalRate(28000)).toBe(0.23);
    expect(irpefMarginalRate(28001)).toBe(0.33);
    expect(irpefMarginalRate(50000)).toBe(0.33);
    expect(irpefMarginalRate(50001)).toBe(0.43);
  });
});
