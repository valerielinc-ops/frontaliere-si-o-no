/** Annual (12 worked months) simulation under DM 14 November 2025, art. 1.
 * This is the frontier-worker contribution, not voluntary SSN registration.
 * Eligibility and the effective regional rate must be checked separately.
 */
export const FRONTIER_SSN_MIN_RATE = 3;
export const FRONTIER_SSN_MAX_RATE = 6;
const ANNUAL_MIN_EUR = 30 * 12;
const ANNUAL_MAX_EUR = 200 * 12;

export function normalizeFrontierSsnRate(ratePercent: number): number {
  const rate = Number.isFinite(ratePercent) ? ratePercent : FRONTIER_SSN_MIN_RATE;
  return Math.max(FRONTIER_SSN_MIN_RATE, Math.min(FRONTIER_SSN_MAX_RATE, rate));
}

export function estimateAnnualFrontierSsnEUR(netSalaryEUR: number, ratePercent: number): number {
  return Math.max(ANNUAL_MIN_EUR, Math.min(ANNUAL_MAX_EUR, netSalaryEUR * normalizeFrontierSsnRate(ratePercent) / 100));
}

export function compareFrontierSsnWithLamal(netSalaryCHF: number, lamalAnnualCHF: number, eurPerCHF: number) {
  const ssnMin = estimateAnnualFrontierSsnEUR(netSalaryCHF * eurPerCHF, FRONTIER_SSN_MIN_RATE) / eurPerCHF;
  const ssnMax = estimateAnnualFrontierSsnEUR(netSalaryCHF * eurPerCHF, FRONTIER_SSN_MAX_RATE) / eurPerCHF;
  const verdict: 'lamal' | 'ssn' | 'depends' = lamalAnnualCHF <= ssnMin ? 'lamal' : lamalAnnualCHF >= ssnMax ? 'ssn' : 'depends';
  // Only an interior crossing changes which option is cheaper. At a capped/floored
  // boundary the same option remains no more expensive throughout the interval.
  const breakevenPct = verdict === 'depends' ? lamalAnnualCHF / netSalaryCHF * 100 : null;
  const saving = verdict === 'lamal' ? ssnMin - lamalAnnualCHF : verdict === 'ssn' ? lamalAnnualCHF - ssnMax : 0;
  return { ssnMin, ssnMax, verdict, breakevenPct, saving };
}
