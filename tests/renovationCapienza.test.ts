import { describe, it, expect } from 'vitest';
import { calculateIrpefGross } from '@/services/calculationService';

describe('calculateIrpefGross', () => {
  it('returns 0 for 0 income', () => {
    expect(calculateIrpefGross(0)).toBe(0);
  });

  it('returns 0 for negative income', () => {
    expect(calculateIrpefGross(-5000)).toBe(0);
  });

  it('applies 23% for income within first bracket (€20,000)', () => {
    // 20000 * 0.23 = 4600
    expect(calculateIrpefGross(20000)).toBe(4600);
  });

  it('applies 23% for income at first bracket boundary (€28,000)', () => {
    // 28000 * 0.23 = 6440
    expect(calculateIrpefGross(28000)).toBe(6440);
  });

  it('applies 23% + 33% for income in second bracket (€40,000)', () => {
    // 28000 * 0.23 = 6440
    // 12000 * 0.33 = 3960 (2026: L. 199/2025 lowered 35% -> 33%)
    // Total = 10400
    expect(calculateIrpefGross(40000)).toBe(10400);
  });

  it('applies 23% + 33% for income at second bracket boundary (€50,000)', () => {
    // 28000 * 0.23 = 6440
    // 22000 * 0.33 = 7260
    // Total = 13700
    expect(calculateIrpefGross(50000)).toBe(13700);
  });

  it('applies all three brackets for income above €50,000 (€80,000)', () => {
    // 28000 * 0.23 = 6440
    // 22000 * 0.33 = 7260
    // 30000 * 0.43 = 12900
    // Total = 26600
    expect(calculateIrpefGross(80000)).toBe(26600);
  });

  it('handles small income correctly (€1,000)', () => {
    expect(calculateIrpefGross(1000)).toBe(230);
  });

  it('handles very large income (€200,000)', () => {
    // 28000 * 0.23 = 6440
    // 22000 * 0.33 = 7260
    // 150000 * 0.43 = 64500
    // Total = 78200
    expect(calculateIrpefGross(200000)).toBe(78200);
  });
});
