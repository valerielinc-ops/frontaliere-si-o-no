/**
 * Parametri previdenziali svizzeri in vigore, letti dal dataset ufficiale
 * `data/pension-parameters/latest.json` (prodotto da
 * scripts/fetch-pension-parameters.mjs, workflow mensile
 * update-pension-parameters.yml: promemoria AVS/AI, pagine UFAS, derivazioni
 * di legge LPP/3a incrociate).
 *
 * E' la fonte delle cifre AVS/LPP/3a usate dai simulatori (aliquote AVS/AD e
 * massimale AD stanno in constants.ts, che e' nel grafo dei build-plugin, e
 * un test le blocca a questo stesso dataset). Prima ogni componente aveva il
 * suo literal e la rendita AVS massima e' rimasta a 2'450 CHF (valore 2024)
 * anche dopo l'adeguamento del 2025 a 2'520.
 *
 * Import con nome: Vite fa tree-shaking delle chiavi JSON, quindi nel bundle
 * entra solo il blocco `federal` (non le schede cantonali).
 */
import { federal, year } from '../data/pension-parameters/latest.json';

/** Anno per cui le fonti dichiarano validi i parametri («Stand am 1. Januar»). */
export const PENSION_PARAMETERS_YEAR: number = year;

/** Rendita AVS di vecchiaia mensile a scala completa (44 anni), minima e massima. */
export const AVS_MIN_MONTHLY_CHF: number = federal.avs.minMonthlyCHF;
export const AVS_MAX_MONTHLY_CHF: number = federal.avs.maxMonthlyCHF;
export const AVS_FULL_CONTRIBUTION_YEARS: number = federal.avs.fullContributionYears;

/** Previdenza professionale obbligatoria (LPP). */
export const LPP_ENTRY_THRESHOLD_CHF: number = federal.lpp.entryThresholdCHF;
export const LPP_COORDINATION_DEDUCTION_CHF: number = federal.lpp.coordinationDeductionCHF;
export const LPP_MIN_COORDINATED_SALARY_CHF: number = federal.lpp.minCoordinatedSalaryCHF;
export const LPP_MAX_INSURED_SALARY_CHF: number = federal.lpp.maxInsuredSalaryCHF;
export const LPP_MIN_INTEREST_RATE: number = federal.lpp.minInterestRatePct / 100;
export const LPP_MIN_CONVERSION_RATE: number = federal.lpp.minConversionRatePct / 100;

/** Massimali annui deducibili del pilastro 3a. */
export const PILLAR_3A_MAX_WITH_LPP_CHF: number = federal.pillar3a.maxWithLppCHF;
export const PILLAR_3A_MAX_WITHOUT_LPP_CHF: number = federal.pillar3a.maxWithoutLppCHF;
