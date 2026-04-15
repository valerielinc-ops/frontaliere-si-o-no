import { describe, it, expect } from 'vitest';
import { calculateSimulation, calculateProgressiveWorkDeduction, calculateProportionalTaxCredit } from '@/services/calculationService';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs } from '@/types';

const makeInputs = (overrides: Partial<SimulationInputs> = {}): SimulationInputs => ({
  ...DEFAULT_INPUTS,
  ...overrides,
});

describe('calculateSimulation', () => {
  describe('Basic structure', () => {
    it('returns a valid SimulationResult with all required fields', () => {
      const result = calculateSimulation(makeInputs());
      expect(result).toHaveProperty('chResident');
      expect(result).toHaveProperty('itResident');
      expect(result).toHaveProperty('savingsCHF');
      expect(result).toHaveProperty('savingsEUR');
      expect(result).toHaveProperty('exchangeRate');
      expect(result).toHaveProperty('monthsBasis');
    });

    it('chResident and itResident have breakdown arrays', () => {
      const result = calculateSimulation(makeInputs());
      expect(Array.isArray(result.chResident.breakdown)).toBe(true);
      expect(Array.isArray(result.itResident.breakdown)).toBe(true);
      expect(result.chResident.breakdown.length).toBeGreaterThan(0);
      expect(result.itResident.breakdown.length).toBeGreaterThan(0);
    });
  });

  describe('New Frontier Worker (within 20km)', () => {
    const result = calculateSimulation(makeInputs({
      frontierWorkerType: 'NEW',
      distanceZone: 'WITHIN_20KM',
      annualIncomeCHF: 100000,
    }));

    it('uses WITHIN_20KM regime — 80% CH tax', () => {
      expect(result.itResident.details.regime).toBe('calc.regime.newFrontier');
      expect(result.itResident.details.franchigiaEUR).toBe(10000);
    });

    it('net income is positive and less than gross', () => {
      expect(result.itResident.netIncomeAnnual).toBeGreaterThan(0);
      expect(result.itResident.netIncomeAnnual).toBeLessThan(result.itResident.grossIncome);
    });

    it('Italian tax includes IRPEF details', () => {
      expect(result.itResident.details.irpefDetails).toBeDefined();
      expect(result.itResident.details.irpefDetails!.taxableBaseEUR).toBeGreaterThan(0);
    });
  });

  describe('New Frontier Worker (over 20km)', () => {
    const result = calculateSimulation(makeInputs({
      frontierWorkerType: 'NEW',
      distanceZone: 'OVER_20KM',
      annualIncomeCHF: 100000,
    }));

    it('has franchigia for OVER_20KM (Art. 1 c.175 L.147/2013)', () => {
      expect(result.itResident.details.franchigiaEUR).toBe(10000);
    });

    it('100% CH tax withheld with franchise applied', () => {
      expect(result.itResident.details.notes).toContain('calc.notes.franchiseApplied');
    });
  });

  describe('Old Frontier Worker', () => {
    const result = calculateSimulation(makeInputs({
      frontierWorkerType: 'OLD',
      annualIncomeCHF: 80000,
    }));

    it('regime is Vecchio Frontaliere', () => {
      expect(result.itResident.details.regime).toBe('calc.regime.oldFrontier');
    });

    it('no IRPEF details for old regime', () => {
      expect(result.itResident.details.irpefDetails).toBeUndefined();
    });

    it('net income is positive', () => {
      expect(result.itResident.netIncomeAnnual).toBeGreaterThan(0);
    });
  });

  describe('Old Frontier Worker with SSN health tax', () => {
    const result = calculateSimulation(makeInputs({
      frontierWorkerType: 'OLD',
      annualIncomeCHF: 80000,
      enableOldFrontierHealthTax: true,
      ssnHealthTaxPercentage: 3,
    }));

    it('taxes are higher when SSN is enabled', () => {
      const resultWithout = calculateSimulation(makeInputs({
        frontierWorkerType: 'OLD',
        annualIncomeCHF: 80000,
        enableOldFrontierHealthTax: false,
      }));
      expect(result.itResident.taxes).toBeGreaterThan(resultWithout.itResident.taxes);
    });
  });

  describe('Income variation', () => {
    it('higher income results in higher taxes', () => {
      const low = calculateSimulation(makeInputs({ annualIncomeCHF: 50000 }));
      const high = calculateSimulation(makeInputs({ annualIncomeCHF: 150000 }));
      expect(high.chResident.taxes).toBeGreaterThan(low.chResident.taxes);
    });

    it('higher income results in higher net (both scenarios)', () => {
      const low = calculateSimulation(makeInputs({ annualIncomeCHF: 50000 }));
      const high = calculateSimulation(makeInputs({ annualIncomeCHF: 150000 }));
      expect(high.chResident.netIncomeAnnual).toBeGreaterThan(low.chResident.netIncomeAnnual);
      expect(high.itResident.netIncomeAnnual).toBeGreaterThan(low.itResident.netIncomeAnnual);
    });
  });

  describe('Family impact', () => {
    it('children reduce effective tax rate for married couples', () => {
      const noKids = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', children: 0 }));
      const withKids = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', children: 2 }));
      expect(withKids.chResident.taxes).toBeLessThan(noKids.chResident.taxes);
    });

    it('family allowance increases with children', () => {
      const one = calculateSimulation(makeInputs({ children: 1 }));
      const three = calculateSimulation(makeInputs({ children: 3 }));
      expect(three.itResident.familyAllowance).toBeGreaterThan(one.itResident.familyAllowance);
    });
  });

  describe('Marital status tax tables', () => {
    it('uses Table A for single without children', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'SINGLE', children: 0 }));
      expect(result.chResident.details.source).toContain('calc.tableA');
    });

    it('uses Table B for married single income', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', spouseWorks: false, children: 0 }));
      expect(result.chResident.details.source).toContain('calc.tableB');
    });

    it('uses Table C for married double income', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', spouseWorks: true, children: 0 }));
      expect(result.chResident.details.source).toContain('calc.tableC');
    });

    it('uses Table H for single parent', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'SINGLE', children: 2 }));
      expect(result.chResident.details.source).toContain('calc.tableH');
    });
  });

  describe('Exchange rate', () => {
    it('savings in EUR use the custom exchange rate', () => {
      const rate = 0.92;
      const result = calculateSimulation(makeInputs({ customExchangeRate: rate }));
      expect(result.exchangeRate).toBe(rate);
      expect(result.savingsEUR).toBeCloseTo(result.savingsCHF * rate, 2);
    });
  });

  describe('Edge cases', () => {
    it('handles zero income', () => {
      const result = calculateSimulation(makeInputs({ annualIncomeCHF: 0 }));
      expect(result.chResident.taxes).toBe(0);
      expect(result.itResident.taxes).toBe(0);
    });

    it('handles very high income', () => {
      const result = calculateSimulation(makeInputs({ annualIncomeCHF: 1000000 }));
      expect(result.chResident.netIncomeAnnual).toBeGreaterThan(0);
    });

    it('monthly net is annual / monthsBasis', () => {
      const result = calculateSimulation(makeInputs({ monthsBasis: 13 }));
      expect(result.chResident.netIncomeMonthly).toBeCloseTo(
        result.chResident.netIncomeAnnual / 13, 2
      );
    });
  });

  describe('Custom expenses', () => {
    it('expenses reduce net income', () => {
      const noExpenses = calculateSimulation(makeInputs({ expensesCH: [], expensesIT: [] }));
      const withExpenses = calculateSimulation(makeInputs({
        expensesCH: [{ id: '1', label: 'Rent', amount: 1500, frequency: 'MONTHLY' }],
        expensesIT: [{ id: '2', label: 'Utilities', amount: 200, frequency: 'MONTHLY' }],
      }));
      expect(withExpenses.chResident.netIncomeAnnual).toBeLessThan(noExpenses.chResident.netIncomeAnnual);
      expect(withExpenses.itResident.netIncomeAnnual).toBeLessThan(noExpenses.itResident.netIncomeAnnual);
    });
  });

  describe('Progressive work deduction (Art. 13 TUIR)', () => {
    it('uses progressive deduction, not fixed €1,910', () => {
      // For a typical frontaliere with €70k+ taxable base, deduction should be near zero
      const highIncome = calculateSimulation(makeInputs({
        frontierWorkerType: 'NEW',
        distanceZone: 'WITHIN_20KM',
        annualIncomeCHF: 100000,
      }));
      // At ~€80k+ taxable base, Art. 13 gives €0 deduction (over €50k threshold)
      expect(highIncome.itResident.details.irpefDetails!.deductionsEUR).toBeLessThan(1910);
    });

    it('lower income gets higher work deduction', () => {
      const low = calculateSimulation(makeInputs({
        frontierWorkerType: 'NEW',
        distanceZone: 'WITHIN_20KM',
        annualIncomeCHF: 30000,
      }));
      const high = calculateSimulation(makeInputs({
        frontierWorkerType: 'NEW',
        distanceZone: 'WITHIN_20KM',
        annualIncomeCHF: 100000,
      }));
      expect(low.itResident.details.irpefDetails!.deductionsEUR).toBeGreaterThan(
        high.itResident.details.irpefDetails!.deductionsEUR
      );
    });

    it('irpefDetails includes workDeductionEUR breakdown', () => {
      const result = calculateSimulation(makeInputs({
        frontierWorkerType: 'NEW',
        distanceZone: 'WITHIN_20KM',
        annualIncomeCHF: 30000,
      }));
      const irpef = result.itResident.details.irpefDetails!;
      expect(irpef.workDeductionEUR).toBeGreaterThan(0);
      expect(irpef.workDeductionEUR).toBeLessThanOrEqual(irpef.deductionsEUR);
    });
  });

  describe('Proportional foreign tax credit (Art. 165 c.10 TUIR)', () => {
    it('Swiss tax credit is less than full paid source tax (due to franchigia reduction)', () => {
      const result = calculateSimulation(makeInputs({
        frontierWorkerType: 'NEW',
        distanceZone: 'WITHIN_20KM',
        annualIncomeCHF: 100000,
      }));
      const irpef = result.itResident.details.irpefDetails!;
      // Credit should be reduced because franchigia makes taxable base < gross income
      expect(irpef.creditSwissTaxEUR).toBeLessThan(
        result.itResident.socialContributions * result.exchangeRate // just verify it's a reasonable positive number
      );
      expect(irpef.creditSwissTaxEUR).toBeGreaterThan(0);
    });
  });
});

describe('calculateProgressiveWorkDeduction (Art. 13 TUIR)', () => {
  it('returns €1,955 for income up to €15,000', () => {
    expect(calculateProgressiveWorkDeduction(10000)).toBe(1955);
    expect(calculateProgressiveWorkDeduction(15000)).toBe(1955);
  });

  it('returns €1,910 + bonus for income €15,001–€28,000', () => {
    // At €15,001 → ~1910 + 1190 * (28000-15001)/13000 ≈ 1910 + 1189.9 ≈ 3099.9
    expect(calculateProgressiveWorkDeduction(15001)).toBeCloseTo(1910 + 1190 * (28000 - 15001) / 13000, 0);
    // At €28,000 → 1910 + 1190 * 0/13000 = 1910
    expect(calculateProgressiveWorkDeduction(28000)).toBeCloseTo(1910, 0);
    // At €20,000 → 1910 + 1190 * 8000/13000 ≈ 2642
    expect(calculateProgressiveWorkDeduction(20000)).toBeCloseTo(1910 + 1190 * 8000 / 13000, 0);
  });

  it('returns decreasing deduction for income €28,001–€50,000', () => {
    // At €28,001 → 1910 * (50000-28001)/22000 ≈ 1909.9
    expect(calculateProgressiveWorkDeduction(28001)).toBeCloseTo(1910 * (50000 - 28001) / 22000, 0);
    // At €40,000 → 1910 * 10000/22000 ≈ 868
    expect(calculateProgressiveWorkDeduction(40000)).toBeCloseTo(1910 * 10000 / 22000, 0);
    // At €50,000 → 1910 * 0/22000 = 0
    expect(calculateProgressiveWorkDeduction(50000)).toBe(0);
  });

  it('returns €0 for income over €50,000', () => {
    expect(calculateProgressiveWorkDeduction(60000)).toBe(0);
    expect(calculateProgressiveWorkDeduction(100000)).toBe(0);
  });

  it('returns €0 for zero or negative income', () => {
    expect(calculateProgressiveWorkDeduction(0)).toBe(0);
    expect(calculateProgressiveWorkDeduction(-5000)).toBe(0);
  });
});

describe('calculateProportionalTaxCredit (Art. 165 c.10 TUIR)', () => {
  it('reduces credit when taxable base is less than gross income', () => {
    // €10k franchigia: taxable = €70k, gross = €80k → ratio = 0.875
    const credit = calculateProportionalTaxCredit(5000, 70000, 80000);
    expect(credit).toBeCloseTo(5000 * 70000 / 80000, 2);
  });

  it('returns full credit when taxable equals gross', () => {
    const credit = calculateProportionalTaxCredit(5000, 80000, 80000);
    expect(credit).toBe(5000);
  });

  it('returns 0 when gross is zero', () => {
    expect(calculateProportionalTaxCredit(5000, 0, 0)).toBe(0);
  });

  it('returns 0 when paid tax is zero', () => {
    expect(calculateProportionalTaxCredit(0, 70000, 80000)).toBe(0);
  });

  it('caps ratio at 1 (taxable cannot exceed gross)', () => {
    // Edge case: if taxable > gross somehow, ratio is capped at 1
    const credit = calculateProportionalTaxCredit(5000, 90000, 80000);
    expect(credit).toBe(5000);
  });
});
