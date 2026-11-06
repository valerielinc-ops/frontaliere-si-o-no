/**
 * jobNetEstimate — shared "netto stimato" wrapper around calculateSimulation.
 *
 * Issue #4307: the job board's per-job net-salary widget and any other
 * caller (e.g. future SEO job-detail pages) MUST derive their estimate from
 * the SAME fiscal logic as the calculator — zero drift by construction.
 * This module owns that logic in exactly one place; it does not
 * reimplement any tax/contribution math, it only calls
 * `calculateSimulation` (services/calculationService.ts) with the job's
 * declared salary and DEFAULT_INPUTS for every other input.
 *
 * Deliberately does NOT touch job structured-data (JobPosting) emission —
 * it only reads salary figures already present on the job record.
 */
import { calculateSimulation } from '@/services/calculationService';
import { DEFAULT_INPUTS } from '@/constants';
import type { SimulationResult } from '@/types';

export interface JobNetEstimate {
  /** Raw CHF salary figures the estimate is derived from. */
  salaryMin: number;
  salaryMax: number | null;
  /** Monthly net estimate for a frontaliere (IT resident, taxed in Italy). */
  frontaliere: { min: number; max: number | null };
  /** Monthly net estimate for a CH resident (Permit B / taxed in Switzerland). */
  resident: { min: number; max: number | null };
}

function runSimulation(annualIncomeCHF: number): SimulationResult | null {
  try {
    return calculateSimulation({ ...DEFAULT_INPUTS, annualIncomeCHF });
  } catch {
    return null;
  }
}

/**
 * Compute a net-salary RANGE from a job's raw min/max CHF salary figures.
 * Returns null when there is no usable minimum (never fabricate a figure —
 * callers must hide the widget entirely in that case, per issue #4307).
 *
 * `salaryMaxRaw` is optional/nullable: when absent, equal to, or below
 * `salaryMinRaw`, the result has `.max: null` on both bands (single-value
 * estimate, not a false range).
 */
export function estimateJobNetSalary(
  salaryMinRaw: number | null | undefined,
  salaryMaxRaw?: number | null,
): JobNetEstimate | null {
  const salaryMin = Number(salaryMinRaw);
  if (!salaryMin || !Number.isFinite(salaryMin) || salaryMin <= 0) return null;

  const maxCandidate = Number(salaryMaxRaw);
  const salaryMax = maxCandidate && Number.isFinite(maxCandidate) && maxCandidate > salaryMin
    ? maxCandidate
    : null;

  const resMin = runSimulation(salaryMin);
  if (!resMin) return null;
  const resMax = salaryMax ? runSimulation(salaryMax) : null;

  return {
    salaryMin,
    salaryMax,
    frontaliere: {
      min: Math.round(resMin.itResident.netIncomeMonthly),
      max: resMax ? Math.round(resMax.itResident.netIncomeMonthly) : null,
    },
    resident: {
      min: Math.round(resMin.chResident.netIncomeMonthly),
      max: resMax ? Math.round(resMax.chResident.netIncomeMonthly) : null,
    },
  };
}
