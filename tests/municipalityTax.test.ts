import { describe, it, expect } from 'vitest';
import { calculateMunicipalityTaxImpact, calculateLombardiaRegionale } from '@/services/calculationService';
import { LOMBARDIA_ADDIZIONALE_REGIONALE } from '@/constants';

describe('calculateLombardiaRegionale', () => {
  it('applies 1.23% for income up to €15,000', () => {
    const tax = calculateLombardiaRegionale(15000);
    expect(tax).toBeCloseTo(15000 * 0.0123, 2);
  });

  it('applies progressive brackets for €30,000', () => {
    // First €15,000 at 1.23%, next €13,000 at 1.58%, next €2,000 at 1.72%
    const expected = 15000 * 0.0123 + 13000 * 0.0158 + 2000 * 0.0172;
    const tax = calculateLombardiaRegionale(30000);
    expect(tax).toBeCloseTo(expected, 2);
  });

  it('applies all brackets for €80,000', () => {
    const expected = 15000 * 0.0123 + 13000 * 0.0158 + 22000 * 0.0172 + 30000 * 0.0173;
    const tax = calculateLombardiaRegionale(80000);
    expect(tax).toBeCloseTo(expected, 2);
  });

  it('returns 0 for zero income', () => {
    expect(calculateLombardiaRegionale(0)).toBe(0);
  });

  it('returns 0 for negative income', () => {
    expect(calculateLombardiaRegionale(-5000)).toBe(0);
  });
});

describe('LOMBARDIA_ADDIZIONALE_REGIONALE brackets', () => {
  it('has 4 brackets', () => {
    expect(LOMBARDIA_ADDIZIONALE_REGIONALE).toHaveLength(4);
  });

  it('last bracket goes to Infinity', () => {
    expect(LOMBARDIA_ADDIZIONALE_REGIONALE[3].upTo).toBe(Infinity);
  });

  it('rates are between 1% and 2%', () => {
    for (const b of LOMBARDIA_ADDIZIONALE_REGIONALE) {
      expect(b.rate).toBeGreaterThanOrEqual(0.01);
      expect(b.rate).toBeLessThanOrEqual(0.02);
    }
  });
});

describe('calculateMunicipalityTaxImpact', () => {
  it('returns a valid result object', () => {
    const result = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    expect(result).toHaveProperty('italianTaxableBaseEUR');
    expect(result).toHaveProperty('irpefGross');
    expect(result).toHaveProperty('addizionaleRegionale');
    expect(result).toHaveProperty('addizionaleComunale');
    expect(result).toHaveProperty('totalAddizionali');
    expect(result).toHaveProperty('deductions');
    expect(result).toHaveProperty('irpefNet');
    expect(result).toHaveProperty('swissTaxCHF');
    expect(result).toHaveProperty('swissTaxCredit');
    expect(result).toHaveProperty('finalItalianTaxEUR');
    expect(result).toHaveProperty('totalTaxEUR');
  });

  it('produces positive tax for typical salary', () => {
    const result = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    expect(result.irpefGross).toBeGreaterThan(0);
    expect(result.italianTaxableBaseEUR).toBeGreaterThan(0);
    expect(result.totalTaxEUR).toBeGreaterThan(0);
  });

  it('applies franchigia for fascia 1', () => {
    const with1 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    const with2 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '2');
    // Fascia 2 has no franchigia → higher taxable base
    expect(with2.italianTaxableBaseEUR).toBeGreaterThan(with1.italianTaxableBaseEUR);
  });

  it('applies franchigia for fascia 1A', () => {
    const with1A = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1A');
    const with2 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '2');
    expect(with2.italianTaxableBaseEUR).toBeGreaterThan(with1A.italianTaxableBaseEUR);
  });

  it('fascia 2 has no franchigia (€10,000 more taxable base)', () => {
    const f1 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    const f2 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '2');
    expect(f2.italianTaxableBaseEUR - f1.italianTaxableBaseEUR).toBeCloseTo(10000, 0);
  });

  it('higher addizionale comunale results in higher tax', () => {
    const low = calculateMunicipalityTaxImpact(80000, 1.06, 0.0, '1');
    const high = calculateMunicipalityTaxImpact(80000, 1.06, 0.8, '1');
    expect(high.addizionaleComunale).toBeGreaterThan(low.addizionaleComunale);
    expect(high.totalAddizionali).toBeGreaterThan(low.totalAddizionali);
  });

  it('Campione d\'Italia (0% addizionale) has zero addizionale comunale', () => {
    const result = calculateMunicipalityTaxImpact(80000, 1.06, 0.0, '1');
    expect(result.addizionaleComunale).toBe(0);
    expect(result.addizionaleRegionale).toBeGreaterThan(0); // regional still applies
  });

  it('addizionale regionale is always positive for positive income', () => {
    const result = calculateMunicipalityTaxImpact(50000, 1.06, 0.5, '1');
    expect(result.addizionaleRegionale).toBeGreaterThan(0);
  });

  it('totalAddizionali = regionale + comunale', () => {
    const result = calculateMunicipalityTaxImpact(100000, 1.06, 0.6, '1');
    expect(result.totalAddizionali).toBeCloseTo(
      result.addizionaleRegionale + result.addizionaleComunale,
      2
    );
  });

  it('higher salary → higher tax', () => {
    const low = calculateMunicipalityTaxImpact(50000, 1.06, 0.5, '1');
    const high = calculateMunicipalityTaxImpact(150000, 1.06, 0.5, '1');
    expect(high.irpefGross).toBeGreaterThan(low.irpefGross);
  });

  it('uses correct LPP rate for different ages', () => {
    const age30 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1', 30);
    const age50 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1', 50);
    // Higher LPP deduction at age 50 → lower taxable base
    expect(age50.italianTaxableBaseEUR).toBeLessThan(age30.italianTaxableBaseEUR);
  });

  it('Swiss tax credit reduces Italian tax', () => {
    const result = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    expect(result.swissTaxCredit).toBeGreaterThan(0);
    expect(result.finalItalianTaxEUR).toBeLessThan(result.irpefNet);
  });

  it('fascia 2 has higher Swiss tax share (100% vs 80%)', () => {
    const f1 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    const f2 = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '2');
    // Fascia 2: 100% Swiss tax stays in CH → larger credit
    expect(f2.swissTaxCredit).toBeGreaterThan(f1.swissTaxCredit);
  });

  it('handles zero salary', () => {
    const result = calculateMunicipalityTaxImpact(0, 1.06, 0.5, '1');
    expect(result.irpefGross).toBe(0);
    expect(result.finalItalianTaxEUR).toBe(0);
  });

  it('produces consistent results across municipalities with same params', () => {
    // Two calls with identical params should produce identical results
    const a = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    const b = calculateMunicipalityTaxImpact(80000, 1.06, 0.5, '1');
    expect(a.finalItalianTaxEUR).toBe(b.finalItalianTaxEUR);
  });
});
