import { describe, expect, it } from 'vitest';
import { compareFrontierSsnWithLamal, estimateAnnualFrontierSsnEUR, normalizeFrontierSsnRate } from '../services/frontierHealthContribution';

describe('calculator SSN rate input boundary', () => {
  it.each([
    [0, 3],
    [10, 6],
  ])('keeps an entered %i%% rate aligned with the calculated %i%% rate', (enteredRate, normalizedRate) => {
    expect(normalizeFrontierSsnRate(enteredRate)).toBe(normalizedRate);
  });
});

describe('frontier-worker SSN annual limits (DM 14 November 2025, article 1)', () => {
  it.each([
    [5000, 3, 360],
    [10000, 10, 600],
    [30000, 1, 900],
    [30000, Number.NaN, 900],
    [30000, 3, 900],
    [30000, 6, 1800],
    [50000, 6, 2400],
    [100000, 3, 2400],
  ])('net EUR %i at %i%% gives EUR %i for 12 worked months', (salary, rate, amount) => {
    expect(estimateAnnualFrontierSsnEUR(salary, rate)).toBe(amount);
  });
});


describe('reachable SSN/LAMal cost crossing', () => {
  it('does not invent a crossing above the capped maximum', () => {
    const result = compareFrontierSsnWithLamal(100000, 3000, 1.096);
    expect(result.ssnMax).toBeCloseTo(2400 / 1.096);
    expect(result.verdict).toBe('ssn');
    expect(result.breakevenPct).toBeNull();
  });
  it('finds an interior crossing when both costs are attainable', () => {
    const result = compareFrontierSsnWithLamal(30000, 1500, 1);
    expect(result.verdict).toBe('depends');
    expect(result.breakevenPct).toBe(5);
  });
  it.each([[5000, 360], [100000, 2400]])('handles a flat range and equality at salary %i', (income, cost) => {
    const result = compareFrontierSsnWithLamal(income, cost, 1);
    expect(result.ssnMin).toBe(result.ssnMax);
    expect(result.saving).toBe(0);
    expect(result.breakevenPct).toBeNull();
  });
});
