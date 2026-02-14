import { describe, it, expect } from 'vitest';
import { calculateSimulation } from '@/services/calculationService';
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
      expect(result.itResident.details.regime).toBe('Nuovo Frontaliere');
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

    it('has no franchigia for OVER_20KM', () => {
      expect(result.itResident.details.franchigiaEUR).toBe(0);
    });

    it('100% CH tax withheld', () => {
      // Check notes for concorrente tassazione
      expect(result.itResident.details.notes).toContain('Nessuna franchigia');
    });
  });

  describe('Old Frontier Worker', () => {
    const result = calculateSimulation(makeInputs({
      frontierWorkerType: 'OLD',
      annualIncomeCHF: 80000,
    }));

    it('regime is Vecchio Frontaliere', () => {
      expect(result.itResident.details.regime).toBe('Vecchio Frontaliere');
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
      expect(result.chResident.details.source).toContain('Tabella A');
    });

    it('uses Table B for married single income', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', spouseWorks: false, children: 0 }));
      expect(result.chResident.details.source).toContain('Tabella B');
    });

    it('uses Table C for married double income', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'MARRIED', spouseWorks: true, children: 0 }));
      expect(result.chResident.details.source).toContain('Tabella C');
    });

    it('uses Table H for single parent', () => {
      const result = calculateSimulation(makeInputs({ maritalStatus: 'SINGLE', children: 2 }));
      expect(result.chResident.details.source).toContain('Tabella H');
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
});
