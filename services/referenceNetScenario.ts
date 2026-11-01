import { calculateSimulation } from './calculationService';
import { DEFAULT_EXCHANGE_RATE, DEFAULT_EXCHANGE_RATE_DATE, DEFAULT_INPUTS } from '../constants';

/** Lordo dello scenario di riferimento citato nelle pagine del sito. */
export const REFERENCE_GROSS_CHF = 80_000;

export type ReferenceNetScenario = {
 grossCHF: number;
 socialCHF: number;
 sourceTaxCHF: number;
 swissNetCHF: number;
 swissNetEUR: number;
 irpefEUR: number;
 creditEUR: number;
 newNetAnnualCHF: number;
 newNetAnnualEUR: number;
 newNetMonthlyCHF: number;
 oldNetAnnualCHF: number;
 oldNetMonthlyCHF: number;
 rate: number;
 rateDate: string;
};

/**
 * Una sola risposta alla domanda "quanto resta di CHF 80.000": single, 30 anni,
 * tabella A, entro 20 km, 12 mensilità, nessun premio sanitario. Le cifre escono
 * dal motore del calcolatore: una pagina che le cita non deve ricopiarle a mano.
 */
export function buildReferenceNetScenario(
 rate: number = DEFAULT_EXCHANGE_RATE,
 rateDate: string = DEFAULT_EXCHANGE_RATE_DATE,
): ReferenceNetScenario {
 const base = {
  ...DEFAULT_INPUTS,
  annualIncomeCHF: REFERENCE_GROSS_CHF,
  healthInsuranceCHF: 0,
  customExchangeRate: rate,
 };
 const next = calculateSimulation({ ...base, frontierWorkerType: 'NEW' }).itResident;
 const old = calculateSimulation({ ...base, frontierWorkerType: 'OLD' }).itResident;
 const irpef = next.details.irpefDetails;
 const swissNetCHF = (next.swissNetIncomeMonthlyCHF ?? 0) * 12;
 return {
  grossCHF: REFERENCE_GROSS_CHF,
  socialCHF: next.socialContributions,
  sourceTaxCHF: REFERENCE_GROSS_CHF - next.socialContributions - swissNetCHF,
  swissNetCHF,
  swissNetEUR: swissNetCHF * rate,
  irpefEUR: (irpef?.grossTaxEUR ?? 0) + (irpef?.addizionaliEUR ?? 0),
  creditEUR: irpef?.creditSwissTaxEUR ?? 0,
  newNetAnnualCHF: next.netIncomeAnnual,
  newNetAnnualEUR: next.netIncomeAnnual * rate,
  newNetMonthlyCHF: next.netIncomeMonthly,
  oldNetAnnualCHF: old.netIncomeAnnual,
  oldNetMonthlyCHF: old.netIncomeMonthly,
  rate,
  rateDate,
 };
}
