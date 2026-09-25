/**
 * E2 — pdfReport.ts regression tests.
 *
 * Verifies:
 *   - generateCalculatorPdfReport() returns a non-empty PDF Blob
 *   - computeCalculatorPdfMetrics() returns the key metrics we render
 *   - missing / partial fields degrade gracefully (no NaN, no throws)
 */
import { describe, it, expect } from 'vitest';
import {
  computeCalculatorPdfMetrics,
  generateCalculatorPdfReport,
  type CalculatorSimulationSnapshot,
} from '@/services/pdfReport';
import type { SimulationResult, SimulationInputs } from '@/types';

const baseResult: SimulationResult = {
  chResident: {
    grossIncome: 80000,
    familyAllowance: 0,
    socialContributions: 10000,
    taxableIncome: 70000,
    taxes: 8000,
    healthInsurance: 4800,
    customExpensesTotal: 0,
    netIncomeAnnual: 57200,
    netIncomeMonthly: 4767,
    currency: 'CHF',
    breakdown: [],
    details: { regime: 'ch', effectiveRate: 10, source: 'test', notes: [] },
  },
  itResident: {
    grossIncome: 80000,
    familyAllowance: 0,
    socialContributions: 8000,
    taxableIncome: 72000,
    taxes: 15000,
    healthInsurance: 0,
    customExpensesTotal: 0,
    netIncomeAnnual: 57000,
    netIncomeMonthly: 4750,
    currency: 'CHF',
    breakdown: [],
    details: { regime: 'calc.regime.newFrontier', effectiveRate: 20, source: 'test', notes: [] },
  },
  savingsCHF: 200,
  savingsEUR: 190,
  exchangeRate: 0.95,
  monthsBasis: 12,
};

const baseInputs = {
  age: 35,
  maritalStatus: 'SINGLE',
  children: 0,
  annualIncomeCHF: 80000,
  frontierWorkerType: 'NEW',
  distanceZone: 'WITHIN_20KM',
  customExchangeRate: 0.95,
  monthsBasis: 12,
} as unknown as SimulationInputs;

const baseSnapshot: CalculatorSimulationSnapshot = {
  result: baseResult,
  inputs: baseInputs,
  locale: 'it',
  generatedAt: new Date('2026-04-24T12:00:00Z'),
};

describe('computeCalculatorPdfMetrics', () => {
  it('returns the 7 key metrics for a valid snapshot', () => {
    const m = computeCalculatorPdfMetrics(baseSnapshot);
    expect(m.netCH_CHF).toBe(57200);
    expect(m.netIT_EUR).toBe(Math.round(57000 * 0.95));
    expect(m.diffAnnuaCHF).toBe(200);
    // Carico fiscale CH = (8000+10000)/80000 = 22.5%
    expect(m.taxBurdenCHPct).toBeCloseTo(22.5, 4);
    // Carico fiscale IT = (15000+8000)/80000 = 28.75%
    expect(m.taxBurdenITPct).toBeCloseTo(28.75, 4);
    expect(m.socialCH_CHF).toBe(10000);
    expect(m.socialIT_EUR).toBe(Math.round(8000 * 0.95));
  });

  it('returns 0s without throwing when gross income is missing', () => {
    const brokenResult: SimulationResult = {
      ...baseResult,
      chResident: { ...baseResult.chResident, grossIncome: 0 },
      itResident: { ...baseResult.itResident, grossIncome: 0 },
    };
    const m = computeCalculatorPdfMetrics({ ...baseSnapshot, result: brokenResult });
    expect(m.taxBurdenCHPct).toBe(0);
    expect(m.taxBurdenITPct).toBe(0);
    // Net income numbers still flow through unchanged
    expect(m.netCH_CHF).toBe(57200);
  });

  it('does not throw on NaN / undefined fields', () => {
    const brokenResult = {
      ...baseResult,
      chResident: {
        ...baseResult.chResident,
        grossIncome: Number.NaN,
        socialContributions: Number.NaN,
      },
      savingsCHF: Number.NaN,
    } as SimulationResult;
    const m = computeCalculatorPdfMetrics({ ...baseSnapshot, result: brokenResult });
    expect(Number.isFinite(m.taxBurdenCHPct)).toBe(true);
    expect(Number.isFinite(m.diffAnnuaCHF)).toBe(true);
    expect(Number.isFinite(m.socialCH_CHF)).toBe(true);
  });
});

describe('generateCalculatorPdfReport', () => {
  it('produces a non-empty PDF blob', async () => {
    const blob = await generateCalculatorPdfReport(baseSnapshot, 'user@example.com');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(500);
    expect(blob.type).toMatch(/pdf|octet-stream/);
  });

  it('still generates a blob when optional fields are missing', async () => {
    const minimal: CalculatorSimulationSnapshot = {
      result: {
        ...baseResult,
        chResident: { ...baseResult.chResident, grossIncome: 0, taxes: 0, socialContributions: 0 },
      },
      inputs: baseInputs,
    };
    const blob = await generateCalculatorPdfReport(minimal, 'fallback@example.com');
    expect(blob.size).toBeGreaterThan(500);
  });

  it('embeds the email address in the document (smoke check via PDF text stream)', async () => {
    const blob = await generateCalculatorPdfReport(baseSnapshot, 'embedded@example.com');
    // jsdom Blob lacks .arrayBuffer(); read via FileReader instead.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsBinaryString(blob);
    });
    // jsPDF writes text as literal strings in the content stream — this is a
    // smoke check, not a guarantee for complex encodings, but it confirms we
    // included the identifier the caller wanted the user to see.
    expect(text).toContain('embedded@example.com');
  });
});
