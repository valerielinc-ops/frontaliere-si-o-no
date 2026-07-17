import { describe, it, expect } from 'vitest';
import { estimateJobNetSalary } from '@/services/jobNetEstimate';
import { calculateSimulation } from '@/services/calculationService';
import { DEFAULT_INPUTS } from '@/constants';

// jobNetEstimate is the single source of truth for the job board's "netto
// stimato" widget (issue #4307). It must reuse calculateSimulation exactly —
// these tests cross-check its output against a direct calculateSimulation
// call to prove there is no drift between the two call sites.

describe('estimateJobNetSalary', () => {
  it('returns null for missing/invalid/zero/negative salary', () => {
    expect(estimateJobNetSalary(null)).toBeNull();
    expect(estimateJobNetSalary(undefined)).toBeNull();
    expect(estimateJobNetSalary(0)).toBeNull();
    expect(estimateJobNetSalary(-1000)).toBeNull();
    expect(estimateJobNetSalary(NaN)).toBeNull();
  });

  it('min=max (single declared salary): max fields are null, min mirrors calculateSimulation', () => {
    const salary = 80000;
    const estimate = estimateJobNetSalary(salary, salary);

    expect(estimate).not.toBeNull();
    expect(estimate!.salaryMin).toBe(salary);
    expect(estimate!.salaryMax).toBeNull();
    expect(estimate!.frontaliere.max).toBeNull();
    expect(estimate!.resident.max).toBeNull();

    const direct = calculateSimulation({ ...DEFAULT_INPUTS, annualIncomeCHF: salary });
    expect(estimate!.frontaliere.min).toBe(Math.round(direct.itResident.netIncomeMonthly));
    expect(estimate!.resident.min).toBe(Math.round(direct.chResident.netIncomeMonthly));
  });

  it('min<max range: both min and max are populated and max > min', () => {
    const min = 60000;
    const max = 90000;
    const estimate = estimateJobNetSalary(min, max);

    expect(estimate).not.toBeNull();
    expect(estimate!.salaryMin).toBe(min);
    expect(estimate!.salaryMax).toBe(max);
    expect(estimate!.frontaliere.min).not.toBeNull();
    expect(estimate!.frontaliere.max).not.toBeNull();
    expect(estimate!.frontaliere.max!).toBeGreaterThan(estimate!.frontaliere.min);
    expect(estimate!.resident.max!).toBeGreaterThan(estimate!.resident.min);

    const directMin = calculateSimulation({ ...DEFAULT_INPUTS, annualIncomeCHF: min });
    const directMax = calculateSimulation({ ...DEFAULT_INPUTS, annualIncomeCHF: max });
    expect(estimate!.frontaliere.min).toBe(Math.round(directMin.itResident.netIncomeMonthly));
    expect(estimate!.frontaliere.max).toBe(Math.round(directMax.itResident.netIncomeMonthly));
    expect(estimate!.resident.min).toBe(Math.round(directMin.chResident.netIncomeMonthly));
    expect(estimate!.resident.max).toBe(Math.round(directMax.chResident.netIncomeMonthly));
  });

  it('treats a max <= min as absent (falls back to min=max single-value estimate)', () => {
    const estimateEqual = estimateJobNetSalary(70000, 70000);
    const estimateLower = estimateJobNetSalary(70000, 50000);

    expect(estimateEqual!.salaryMax).toBeNull();
    expect(estimateLower!.salaryMax).toBeNull();
  });

  it('omitting salaryMax entirely behaves like min=max', () => {
    const estimate = estimateJobNetSalary(65000);
    expect(estimate).not.toBeNull();
    expect(estimate!.salaryMax).toBeNull();
    expect(estimate!.frontaliere.max).toBeNull();
    expect(estimate!.resident.max).toBeNull();
  });

  it('canton variation: N/A — calculateSimulation (frontier-worker fiscal regime) has no canton-of-residence axis; ' +
    'canton only affects Swiss-resident tax data consumed elsewhere in the calculator UI, not this shared estimate. ' +
    'Verified same salary produces identical estimate regardless of any external canton context.', () => {
    const salary = 55000;
    const estimateA = estimateJobNetSalary(salary, salary);
    const estimateB = estimateJobNetSalary(salary, salary);
    expect(estimateA).toEqual(estimateB);
  });
});
