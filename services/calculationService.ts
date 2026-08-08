import { SimulationInputs, SimulationResult, TaxResult, TaxBreakdownItem, ExpenseItem } from '../types';
import { FRANCHIGIA_NUOVI_FRONTALIERI, SWISS_CHILD_ALLOWANCE_ANNUAL, LINKS, LOMBARDIA_ADDIZIONALE_REGIONALE, DEFAULT_TECH_PARAMS } from '../constants';

// Accordo 2024 concurrent-taxation split: only this share of the ordinary CH
// source tax is withheld for a "nuovo frontaliere" resident within 20km of the
// border; the remainder is taxed in Italy instead. Single source of truth —
// previously duplicated as a bare 0.8 literal in three places (issue #5374).
export const NEW_FRONTIER_WITHIN_20KM_CH_SHARE = 0.8;

// --- DATA: TAX TABLES 2026 (Approximation via Interpolation Points) ---
const TABLE_A_POINTS = [[0, 0], [17000, 0.20], [25000, 2.00], [30000, 3.20], [40000, 5.20], [50000, 6.00], [60000, 8.50], [80000, 11.30], [100000, 13.20], [120000, 14.90], [130000, 15.70], [135000, 16.00], [140000, 16.50], [150000, 17.20], [180000, 18.90], [200000, 19.40], [250000, 22.80], [300000, 24.50], [500000, 28.30], [1000000, 31.50]];
const TABLE_B_POINTS = [[0, 0], [25000, 0.30], [30000, 0.70], [40000, 1.10], [50000, 1.50], [60000, 2.50], [80000, 5.10], [100000, 8.70], [120000, 10.70], [140000, 12.80], [160000, 14.40], [180000, 15.60], [200000, 16.50], [250000, 20.20], [300000, 22.80], [500000, 26.50]];
const TABLE_C_POINTS = [[0, 0], [20000, 0.20], [30000, 1.90], [40000, 4.40], [50000, 6.20], [60000, 8.20], [80000, 11.20], [100000, 13.10], [120000, 14.90], [140000, 16.40], [160000, 17.60], [180000, 18.90], [200000, 19.50], [250000, 22.90], [300000, 25.10], [500000, 28.50]];
const TABLE_H_POINTS = [[0, 0], [35000, 0.20], [40000, 1.10], [50000, 1.80], [60000, 2.50], [80000, 4.70], [100000, 7.10], [120000, 9.30], [140000, 11.70], [160000, 13.50], [180000, 14.90], [200000, 16.00], [250000, 19.40], [300000, 21.70]];

const interpolate = (value: number, points: number[][]): number => {
 if (value <= points[0][0]) return points[0][1];
 if (value >= points[points.length - 1][0]) return points[points.length - 1][1];
 for (let i = 0; i < points.length - 1; i++) {
 const [x0, y0] = points[i];
 const [x1, y1] = points[i + 1];
 if (value >= x0 && value < x1) return y0 + (value - x0) * (y1 - y0) / (x1 - x0);
 }
 return 0;
};

export const getTicinoTaxRate = (income: number, marital: string, children: number, spouseWorks: boolean): { rate: number, table: string, tableCode: string } => {
 if (['SINGLE', 'DIVORCED', 'WIDOWED'].includes(marital)) {
 if (children > 0) return { rate: interpolate(income, TABLE_H_POINTS) / 100, table: "calc.tableH", tableCode: "H" };
 else return { rate: interpolate(income, TABLE_A_POINTS) / 100, table: "calc.tableA", tableCode: "A" };
 }
 if (marital === 'MARRIED') {
 if (spouseWorks) return { rate: interpolate(income, TABLE_C_POINTS) / 100, table: "calc.tableC", tableCode: "C" };
 else return { rate: interpolate(income, TABLE_B_POINTS) / 100, table: "calc.tableB", tableCode: "B" };
 }
 return { rate: 0.10, table: "calc.tableStandard", tableCode: "A" };
};

export const adjustRateForChildren = (baseRate: number, tableCode: string, children: number): number => {
 if (children === 0) return baseRate;
 let discountPerChild = 0;
 if (tableCode === 'A') return baseRate;
 if (tableCode === 'H') discountPerChild = 0.015;
 if (tableCode === 'B') discountPerChild = 0.025;
 if (tableCode === 'C') discountPerChild = 0.021;
 return Math.max(0.005, baseRate - (discountPerChild * children));
};

const calcExpensesTotal = (expenses: ExpenseItem[]): number => {
 return expenses.reduce((acc, exp) => acc + (exp.frequency === 'MONTHLY' ? exp.amount * 12 : exp.amount), 0);
};

// Ticino wealth tax (imposta sulla sostanza) for Permit B residents
// Tax-free threshold: CHF 200,000 single / CHF 200,000 married (source: Comparis.ch, Art. 58 LT)
// Progressive per-mille rates on net wealth above threshold (cantonal + avg municipal combined)
const calculateTicinoWealthTax = (netWealth: number): number => {
 if (netWealth <= 200000) return 0;
 const taxable = netWealth - 200000;
 // Progressive brackets on taxable portion (per-mille rates, cantonal base + avg municipal multiplier ~95%)
 const brackets: [number, number][] = [
 [100000, 1.5], // 200,001–300,000: 1.5‰
 [200000, 2.0], // 300,001–500,000: 2.0‰
 [500000, 2.5], // 500,001–1,000,000: 2.5‰
 [Infinity, 3.0], // 1,000,001+: 3.0‰
 ];
 let tax = 0;
 let remaining = taxable;
 for (const [width, ratePerMille] of brackets) {
 const slice = Math.min(remaining, width);
 tax += slice * (ratePerMille / 1000);
 remaining -= slice;
 if (remaining <= 0) break;
 }
 return Math.round(tax);
};

export const calculateSimulation = (inputs: SimulationInputs): SimulationResult => {
 const { annualIncomeCHF, children, healthInsuranceCHF, frontierWorkerType, customExchangeRate, monthsBasis, distanceZone, age, maritalStatus, spouseWorks, avsRate, acRate, laaRate, ijmRate, lppRate25_34, lppRate35_44, lppRate45_54, lppRate55_plus, itAddizionaleRate, itWorkDeduction, expensesCH, expensesIT, enableOldFrontierHealthTax, ssnHealthTaxPercentage, netWealthCHF } = inputs;
 const EXCHANGE_RATE = customExchangeRate;

 const avsAmount = annualIncomeCHF * avsRate;
 const acAmount = Math.min(annualIncomeCHF, 148200) * acRate;
 const laaAmount = annualIncomeCHF * laaRate;
 const ijmAmount = annualIncomeCHF * ijmRate;
 
 let lppRate = lppRate25_34;
 if (age >= 35 && age <= 44) lppRate = lppRate35_44;
 if (age >= 45 && age <= 54) lppRate = lppRate45_54;
 if (age >= 55) lppRate = lppRate55_plus;
 const lppAmount = annualIncomeCHF * lppRate;

 const totalSocialDeductions = avsAmount + acAmount + laaAmount + ijmAmount + lppAmount;
 const annualFamilyAllowanceCHF = children * SWISS_CHILD_ALLOWANCE_ANNUAL;

 const { rate: baseRate, table: appliedTable, tableCode } = getTicinoTaxRate(annualIncomeCHF, maritalStatus, children, spouseWorks);
 const effectiveTaxRateCH = adjustRateForChildren(baseRate, tableCode, children);
 const totalTaxCH = annualIncomeCHF * effectiveTaxRateCH;
 const healthAnnualCH = healthInsuranceCHF * inputs.familyMembers * 12;
 const expensesTotalCH = calcExpensesTotal(expensesCH);
 const wealthTaxCH = calculateTicinoWealthTax(netWealthCHF || 0);

 const grossTotalCH = annualIncomeCHF + annualFamilyAllowanceCHF;
 const netIncomeAnnualCH = grossTotalCH - totalSocialDeductions - totalTaxCH - healthAnnualCH - expensesTotalCH - wealthTaxCH;

 const chResidentResult: TaxResult = {
 grossIncome: annualIncomeCHF, familyAllowance: annualFamilyAllowanceCHF, socialContributions: totalSocialDeductions, taxableIncome: annualIncomeCHF, taxes: totalTaxCH, healthInsurance: healthAnnualCH, customExpensesTotal: expensesTotalCH, netIncomeAnnual: netIncomeAnnualCH, netIncomeMonthly: netIncomeAnnualCH / monthsBasis, currency: 'CHF',
 breakdown: [
 { label: 'calc.workIncome', amount: annualIncomeCHF, percentage: (annualIncomeCHF/grossTotalCH)*100, description: 'calc.workIncomeDesc' },
 { label: 'calc.familyAllowance', amount: annualFamilyAllowanceCHF, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100, description: 'calc.familyAllowanceDesc' },
 { label: 'calc.socialContributions', amount: -(avsAmount + acAmount + laaAmount + ijmAmount), percentage: ((avsAmount + acAmount + laaAmount + ijmAmount)/grossTotalCH)*100, description: 'calc.socialContributionsDesc' },
 { label: 'calc.pension', amount: -lppAmount, percentage: (lppAmount/grossTotalCH)*100, description: 'calc.pensionDesc' },
 { label: 'calc.totalTaxes', amount: -totalTaxCH, percentage: (totalTaxCH/grossTotalCH)*100, description: 'calc.totalTaxesDesc' },
 { label: 'calc.healthInsurance', amount: -healthAnnualCH, percentage: (healthAnnualCH/grossTotalCH)*100, description: `calc.healthInsuranceDesc|${healthInsuranceCHF}|${inputs.familyMembers}` },
 ...(wealthTaxCH > 0 ? [{ label: 'calc.wealthTax', amount: -wealthTaxCH, percentage: (wealthTaxCH/grossTotalCH)*100, description: 'calc.wealthTaxDesc' }] : []),
 { label: 'calc.personalExpenses', amount: -expensesTotalCH, percentage: (expensesTotalCH/grossTotalCH)*100, description: 'calc.personalExpensesDesc' },
 { label: 'calc.netAnnualIncome', amount: netIncomeAnnualCH, percentage: (netIncomeAnnualCH/grossTotalCH)*100, description: `calc.netIncomeDescCH|${(effectiveTaxRateCH*100).toFixed(1)}|${tableCode}` },
 ],
 details: { regime: "calc.regime.chResident", effectiveRate: (totalTaxCH / grossTotalCH) * 100, source: appliedTable, notes: [`calc.notes.standardRates`, `calc.notes.taxTable|${tableCode}`] }
 };

 let chTaxShare = (frontierWorkerType === 'NEW' && distanceZone === 'WITHIN_20KM') ? NEW_FRONTIER_WITHIN_20KM_CH_SHARE : 1.0;
 const taxWithheldInCH_CHF = totalTaxCH * chTaxShare;
 const expensesTotalIT = calcExpensesTotal(expensesIT);
 const expensesTotalIT_CHF = expensesTotalIT / EXCHANGE_RATE; // Convert EUR to CHF

 const grossIncomeEUR = annualIncomeCHF * EXCHANGE_RATE;
 const allowanceEUR = annualFamilyAllowanceCHF * EXCHANGE_RATE;
 const socialEUR = totalSocialDeductions * EXCHANGE_RATE;
 let paidSourceTaxEUR = taxWithheldInCH_CHF * EXCHANGE_RATE;
 
 let finalItTaxEUR = 0;
 let notesIT: string[] = [];
 let itBreakdown: TaxBreakdownItem[] = [];

 const taxPercentage = ssnHealthTaxPercentage ?? 3;
 let franchigiaUsed = 0;
 let irpefDetails = undefined;

 if (frontierWorkerType === 'OLD') {
 notesIT = ["calc.notes.exclusiveTax"];
 
 // Calculate SSN Health Tax for Old Frontier Workers (if enabled)
 let ssnHealthTaxEUR = 0;
 let ssnHealthTaxCHF = 0;
 const netBeforeSsnEUR = (grossTotalCH - totalSocialDeductions - taxWithheldInCH_CHF - expensesTotalIT_CHF) * EXCHANGE_RATE;
 
 if (enableOldFrontierHealthTax) {
 // SSN Tax: configurable % of net income, min 30€/month (360€/year), max 200€/month (2400€/year)
 ssnHealthTaxEUR = Math.max(360, Math.min(2400, netBeforeSsnEUR * (taxPercentage / 100)));
 ssnHealthTaxCHF = ssnHealthTaxEUR / EXCHANGE_RATE;
 notesIT.push(`calc.ssnHealthTaxNote|${Math.round(ssnHealthTaxEUR/12)}|${taxPercentage}`);
 }
 
 itBreakdown = [
 { label: 'calc.grossIncome', amount: annualIncomeCHF, amountEUR: grossIncomeEUR, percentage: (annualIncomeCHF/grossTotalCH)*100, description: 'calc.grossIncomeDesc' },
 { label: 'calc.familyAllowanceCH', amount: annualFamilyAllowanceCHF, amountEUR: allowanceEUR, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100, description: 'calc.familyAllowanceCHDesc' },
 { label: 'calc.socialContributionsCH', amount: -totalSocialDeductions, amountEUR: -socialEUR, percentage: (totalSocialDeductions/grossTotalCH)*100, description: 'calc.socialContributionsCHDesc' },
 { label: 'calc.sourceChFull', amount: -taxWithheldInCH_CHF, amountEUR: -paidSourceTaxEUR, percentage: (taxWithheldInCH_CHF/grossTotalCH)*100, description: 'calc.sourceChFullDesc' },
 ];
 
 // Add SSN Tax line if enabled
 if (enableOldFrontierHealthTax && ssnHealthTaxCHF > 0) {
 itBreakdown.push({ 
 label: 'calc.ssnHealthTax', 
 amount: -ssnHealthTaxCHF, 
 amountEUR: -ssnHealthTaxEUR, 
 percentage: (ssnHealthTaxCHF/grossTotalCH)*100, 
 description: `calc.ssnHealthTaxDesc|${Math.round(ssnHealthTaxEUR/12)}` 
 });
 }
 
 itBreakdown.push({ 
 label: 'calc.personalExpensesIT', 
 amount: -expensesTotalIT_CHF, 
 amountEUR: -expensesTotalIT, 
 percentage: (expensesTotalIT_CHF/grossTotalCH)*100, 
 description: 'calc.personalExpensesITDesc' 
 });
 
 // Update totalTaxIT_CHF to include SSN if enabled
 const totalTaxIT_CHF_OLD = taxWithheldInCH_CHF + ssnHealthTaxCHF;
 const netAnnualIT_CHF_OLD = grossTotalCH - totalSocialDeductions - totalTaxIT_CHF_OLD - expensesTotalIT_CHF;
 
 itBreakdown.push({
 label: 'calc.netAnnualIncome',
 amount: netAnnualIT_CHF_OLD,
 amountEUR: netAnnualIT_CHF_OLD * EXCHANGE_RATE,
 percentage: (netAnnualIT_CHF_OLD/grossTotalCH)*100,
 description: notesIT.join("||")
 });

 const netSwissSalaryAnnual_OLD = grossTotalCH - totalSocialDeductions - taxWithheldInCH_CHF;
 
 return {
 chResident: chResidentResult,
 itResident: { 
 grossIncome: annualIncomeCHF, 
 familyAllowance: annualFamilyAllowanceCHF, 
 socialContributions: totalSocialDeductions, 
 taxableIncome: annualIncomeCHF, 
 taxes: totalTaxIT_CHF_OLD, 
 healthInsurance: 0, 
 customExpensesTotal: expensesTotalIT_CHF, 
 netIncomeAnnual: netAnnualIT_CHF_OLD, 
 netIncomeMonthly: netAnnualIT_CHF_OLD / monthsBasis, 
 swissNetIncomeMonthlyCHF: netSwissSalaryAnnual_OLD / monthsBasis,
 currency: 'CHF', 
 breakdown: itBreakdown, 
 details: { regime: "calc.regime.oldFrontier", effectiveRate: (totalTaxIT_CHF_OLD / grossTotalCH) * 100, source: "calc.notes.fiscalAgreement", franchigiaEUR: 0, notes: notesIT } 
 },
 savingsCHF: netAnnualIT_CHF_OLD - netIncomeAnnualCH,
 savingsEUR: (netAnnualIT_CHF_OLD - netIncomeAnnualCH) * EXCHANGE_RATE,
 exchangeRate: EXCHANGE_RATE,
 monthsBasis: monthsBasis
 };
 } else {
 franchigiaUsed = FRANCHIGIA_NUOVI_FRONTALIERI;
 const italianTaxableBaseEUR = Math.max(0, grossIncomeEUR + allowanceEUR - socialEUR - franchigiaUsed);
 const irpefGross = calculateIrpefGross(italianTaxableBaseEUR);

 const progressiveWorkDeduction = calculateProgressiveWorkDeduction(italianTaxableBaseEUR);
 const itDeductions = progressiveWorkDeduction + (maritalStatus === 'MARRIED' && !spouseWorks ? 690 : 0) + (children * 950);
 const addizionali = italianTaxableBaseEUR * itAddizionaleRate;
 const itLiability = Math.max(0, irpefGross + addizionali - itDeductions);
 // Proportional foreign tax credit per Art. 165 c.10 TUIR + Ris. 38/E/2017
 const usableTaxCredit = calculateProportionalTaxCredit(paidSourceTaxEUR, italianTaxableBaseEUR, grossIncomeEUR + allowanceEUR);
 finalItTaxEUR = Math.max(0, itLiability - usableTaxCredit);
 const finalItTaxCHF = finalItTaxEUR / EXCHANGE_RATE;

 irpefDetails = { taxableBaseEUR: italianTaxableBaseEUR, grossTaxEUR: irpefGross, deductionsEUR: itDeductions, workDeductionEUR: progressiveWorkDeduction, addizionaliEUR: addizionali, creditSwissTaxEUR: usableTaxCredit, finalNetTaxEUR: finalItTaxEUR };
 notesIT = ["calc.regime.newFrontier", "calc.notes.concurrentTax", "calc.notes.franchiseApplied"];

 // Build IRPEF sub-items for expandable breakdown
 const irpefSubItems = [
 { label: 'calc.irpefGross', amountEUR: irpefGross },
 { label: 'calc.irpefAddizionali', amountEUR: addizionali },
 { label: 'calc.irpefWorkDeduction', amountEUR: -progressiveWorkDeduction },
 ...(maritalStatus === 'MARRIED' && !spouseWorks ? [{ label: 'calc.irpefSpouseDeduction', amountEUR: -690 }] : []),
 ...(children > 0 ? [{ label: 'calc.irpefChildrenDeduction', amountEUR: -(children * 950) }] : []),
 { label: 'calc.irpefSwissCredit', amountEUR: -usableTaxCredit },
 ];

 itBreakdown = [
 { label: 'calc.grossIncome', amount: annualIncomeCHF, amountEUR: grossIncomeEUR, percentage: (annualIncomeCHF/grossTotalCH)*100, description: 'calc.grossIncomeDesc' },
 { label: 'calc.familyAllowanceCH', amount: annualFamilyAllowanceCHF, amountEUR: allowanceEUR, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100, description: 'calc.familyAllowanceCHDesc2' },
 { label: 'calc.socialContributionsCH', amount: -totalSocialDeductions, amountEUR: -socialEUR, percentage: (totalSocialDeductions/grossTotalCH)*100, description: 'calc.socialContributionsCHDeductibleDesc' },
 { label: `calc.sourceCHPartial|${Math.round(chTaxShare * 100)}`, amount: -taxWithheldInCH_CHF, amountEUR: -paidSourceTaxEUR, percentage: (taxWithheldInCH_CHF/grossTotalCH)*100, description: 'calc.sourceCHPartialDesc' },
 { label: 'calc.irpefBalance', amount: -finalItTaxCHF, amountEUR: -finalItTaxEUR, percentage: (finalItTaxCHF/grossTotalCH)*100, description: 'calc.irpefBalanceDesc', subItems: irpefSubItems },
 { label: 'calc.personalExpensesIT', amount: -expensesTotalIT_CHF, amountEUR: -expensesTotalIT, percentage: (expensesTotalIT_CHF/grossTotalCH)*100, description: 'calc.personalExpensesITDesc' },
 ];
 }

 const totalTaxIT_CHF = taxWithheldInCH_CHF + (finalItTaxEUR / EXCHANGE_RATE);
 const netAnnualIT_CHF = grossTotalCH - totalSocialDeductions - totalTaxIT_CHF - expensesTotalIT_CHF;
 const netSwissSalaryAnnual = grossTotalCH - totalSocialDeductions - taxWithheldInCH_CHF;
 
 // Add Net Income Row
 itBreakdown.push({
 label: 'calc.netAnnualIncome',
 amount: netAnnualIT_CHF,
 amountEUR: netAnnualIT_CHF * EXCHANGE_RATE,
 percentage: (netAnnualIT_CHF/grossTotalCH)*100,
 description: notesIT.join("||")
 });

 return {
 chResident: chResidentResult,
 itResident: {
 grossIncome: annualIncomeCHF,
 familyAllowance: annualFamilyAllowanceCHF,
 socialContributions: totalSocialDeductions,
 taxableIncome: annualIncomeCHF,
 taxes: totalTaxIT_CHF, 
 healthInsurance: 0, 
 customExpensesTotal: expensesTotalIT_CHF, 
 netIncomeAnnual: netAnnualIT_CHF, 
 netIncomeMonthly: netAnnualIT_CHF / monthsBasis, 
 swissNetIncomeMonthlyCHF: netSwissSalaryAnnual / monthsBasis,
 currency: 'CHF', 
 breakdown: itBreakdown, 
 details: { regime: "calc.regime.newFrontier", effectiveRate: (totalTaxIT_CHF / grossTotalCH) * 100, source: "calc.notes.fiscalAgreement", franchigiaEUR: franchigiaUsed, notes: notesIT, irpefDetails: irpefDetails } 
 },
 savingsCHF: netAnnualIT_CHF - netIncomeAnnualCH,
 savingsEUR: (netAnnualIT_CHF - netIncomeAnnualCH) * EXCHANGE_RATE,
 exchangeRate: EXCHANGE_RATE,
 monthsBasis: monthsBasis
 };
};

/**
 * Calculate gross IRPEF from a taxable base using 2026 Italian brackets.
 * Exported for reuse in RenovationCalculator (OLD frontaliere mini-calc).
 */
export function calculateIrpefGross(taxableBase: number): number {
 if (taxableBase <= 0) return 0;
 if (taxableBase <= 28000) return taxableBase * 0.23;
 if (taxableBase <= 50000) return 28000 * 0.23 + (taxableBase - 28000) * 0.35;
 return 28000 * 0.23 + 22000 * 0.35 + (taxableBase - 50000) * 0.43;
}

/**
 * Progressive work deduction (detrazione lavoro dipendente) per Art. 13 TUIR.
 * The deduction decreases as income increases and reaches zero above €50,000.
 * 2024-2026 brackets (post D.Lgs. 216/2023 reform):
 * - Up to €15,000: €1,955
 * - €15,001–€28,000: €1,910 + 1,190 × (28,000 − reddito) / 13,000
 * - €28,001–€50,000: €1,910 × (50,000 − reddito) / 22,000
 * - Over €50,000: €0
 */
export function calculateProgressiveWorkDeduction(taxableBaseEUR: number): number {
 if (taxableBaseEUR <= 0) return 0;
 if (taxableBaseEUR <= 15000) return 1955;
 if (taxableBaseEUR <= 28000) return 1910 + 1190 * (28000 - taxableBaseEUR) / 13000;
 if (taxableBaseEUR <= 50000) return 1910 * (50000 - taxableBaseEUR) / 22000;
 return 0;
}

/**
 * Calculate proportional foreign tax credit per Art. 165 c.10 TUIR.
 * When foreign income only partially contributes to the Italian taxable base
 * (e.g. due to franchigia deduction), the usable credit must be reduced proportionally.
 * Formula: creditUsable = paidSourceTaxEUR × (italianTaxableBase / grossForeignIncome)
 * Ref: Risoluzione 38/E/2017 Agenzia delle Entrate
 */
export function calculateProportionalTaxCredit(
 paidSourceTaxEUR: number,
 italianTaxableBaseEUR: number,
 grossForeignIncomeEUR: number,
): number {
 if (grossForeignIncomeEUR <= 0 || paidSourceTaxEUR <= 0) return 0;
 const ratio = Math.min(1, Math.max(0, italianTaxableBaseEUR / grossForeignIncomeEUR));
 return paidSourceTaxEUR * ratio;
}

// ─── Ticino municipal tax multiplier (issue #4470) ───────────────────────────
/**
 * Extra annual CH tax (CHF) a Ticino RESIDENT (permit B/C) pays in a given
 * municipality relative to the cantonal-average multiplier already baked into
 * the source-tax tariff used by `calculateSimulation`.
 *
 * Ticino levies: imposta_totale = imposta_cantonale_base × (1 + moltiplicatore
 * comunale / 100). The withholding tariff embeds the cantonal-AVERAGE municipal
 * multiplier (`baselineMultiplierPct`), so `baseTicinoTaxAnnualCHF` already
 * corresponds to that baseline. Only the municipal share scales with the chosen
 * comune, hence:
 *
 *   base_cantonal          = baseTax / (1 + baseline/100)
 *   tax(comune)            = base_cantonal × (1 + m/100)
 *   delta                  = tax(comune) − baseTax
 *                          = baseTax × (m − baseline) / (100 + baseline)
 *
 * A comune with a HIGHER multiplier than the baseline returns a positive delta
 * (more tax → lower net); a lower one returns a negative delta (more net).
 * Pure and side-effect-free — unit-tested in tests/ticino-municipal-tax.test.ts.
 */
export function ticinoMunicipalTaxDeltaCHF(
  baseTicinoTaxAnnualCHF: number,
  multiplierPct: number,
  baselineMultiplierPct: number,
): number {
  if (!Number.isFinite(baseTicinoTaxAnnualCHF) || baseTicinoTaxAnnualCHF <= 0) return 0;
  if (!Number.isFinite(multiplierPct) || !Number.isFinite(baselineMultiplierPct)) return 0;
  const denom = 100 + baselineMultiplierPct;
  if (denom <= 0) return 0;
  return baseTicinoTaxAnnualCHF * (multiplierPct - baselineMultiplierPct) / denom;
}

/**
 * Adjusted total CH tax (CHF/year) for a Ticino resident once the selected
 * municipality's multiplier is applied. Never returns below 0.
 */
export function applyTicinoMunicipalMultiplier(
  baseTicinoTaxAnnualCHF: number,
  multiplierPct: number,
  baselineMultiplierPct: number,
): number {
  const adjusted = baseTicinoTaxAnnualCHF
    + ticinoMunicipalTaxDeltaCHF(baseTicinoTaxAnnualCHF, multiplierPct, baselineMultiplierPct);
  return Math.max(0, adjusted);
}

// ─── NASpI 2026 (INPS circular) ──────────────────────────────────────────────
/**
 * Single source of truth for NASpI constants — previously duplicated only
 * inside `components/calculator/NaspiCalculator.tsx` (see AGENTS.md #6).
 *
 * THRESHOLD/MAX_MONTHLY per Circolare INPS n.4 del 28/1/2026 (rivalutati
 * annualmente — verificare i valori correnti al momento dell'implementazione).
 * MIN_WEEKS_REQUIRED innalzato da 13 a 18 settimane dalla Legge di Bilancio
 * 2026 (requisito minimo di contribuzione nel quadriennio per aver diritto
 * alla NASpI).
 */
export const NASPI_2026 = {
  THRESHOLD: 1_456.72, // € — soglia retribuzione mensile
  MAX_MONTHLY: 1_584.70, // € — tetto massimo mensile
  RATE_BELOW: 0.75, // 75% fino alla soglia
  RATE_ABOVE: 0.25, // 25% sull'eccedenza
  DECALAGE_RATE: 0.03, // -3% al mese
  DECALAGE_START_NORMAL: 6, // dal 6° mese (< 55 anni)
  DECALAGE_START_SENIOR: 8, // dall'8° mese (≥ 55 anni)
  MAX_DURATION_MONTHS: 24,
  WEEKS_PER_MONTH: 4.33,
  MIN_WEEKS_REQUIRED: 18, // requisito minimo di contribuzione nel quadriennio (Legge di Bilancio 2026)
};

export interface NaspiMonthRow {
  month: number;
  gross: number;
  cumulative: number;
  decalagePercent: number;
}

export interface NaspiResult {
  monthlyInitial: number;
  duration: number;
  rows: NaspiMonthRow[];
  totalGross: number;
  /** False when net contributed weeks fall below the 18-week minimum requirement (Legge di Bilancio 2026) — no NASpI entitlement at all, distinct from a short-but-nonzero duration. */
  eligible: boolean;
}

/**
 * Calculate NASpI amount and duration.
 *
 * `monthsAlreadyIndemnifiedInQuadriennio` (default 0) accounts for a PRIOR
 * NASpI already received within the same reference 4-year window: per INPS
 * circular, the contribution weeks that already generated a previous NASpI
 * indemnity are excluded when computing the new duration, to prevent the
 * same contribution period from being counted twice.
 */
export function calculateNaspi(
  grossMonthlyCHF: number,
  monthsWorked: number,
  age: number,
  exchangeRate: number,
  monthsAlreadyIndemnifiedInQuadriennio: number = 0,
): NaspiResult {
  const { THRESHOLD, MAX_MONTHLY, RATE_BELOW, RATE_ABOVE, DECALAGE_RATE, DECALAGE_START_NORMAL, DECALAGE_START_SENIOR, MAX_DURATION_MONTHS, WEEKS_PER_MONTH, MIN_WEEKS_REQUIRED } = NASPI_2026;

  // Convert CHF → EUR
  const grossMonthlyEUR = grossMonthlyCHF * exchangeRate;

  // Calculate initial monthly amount
  const belowThreshold = Math.min(grossMonthlyEUR, THRESHOLD);
  const aboveThreshold = Math.max(0, grossMonthlyEUR - THRESHOLD);
  let monthlyInitial = belowThreshold * RATE_BELOW + aboveThreshold * RATE_ABOVE;
  monthlyInitial = Math.min(monthlyInitial, MAX_MONTHLY);

  // Duration: half the weeks contributed in last 4 years (net of weeks already
  // indemnified by a prior NASpI in the same quadriennio), capped at 24 months.
  // Below the 18-week minimum requirement there is no entitlement at all.
  const weeksContributed = Math.round(monthsWorked * WEEKS_PER_MONTH);
  const weeksAlreadyIndemnified = Math.round(monthsAlreadyIndemnifiedInQuadriennio * WEEKS_PER_MONTH);
  const netWeeksContributed = Math.max(0, weeksContributed - weeksAlreadyIndemnified);
  const eligible = netWeeksContributed >= MIN_WEEKS_REQUIRED;
  const durationWeeks = eligible ? Math.floor(netWeeksContributed / 2) : 0;
  const duration = eligible ? Math.min(Math.ceil(durationWeeks / WEEKS_PER_MONTH), MAX_DURATION_MONTHS) : 0;

  // Decalage start based on age
  const decalageStart = age >= 55 ? DECALAGE_START_SENIOR : DECALAGE_START_NORMAL;

  // Build month-by-month table
  const rows: NaspiMonthRow[] = [];
  let cumulative = 0;
  for (let m = 1; m <= duration; m++) {
    const decalageMonths = m >= decalageStart ? m - decalageStart : 0;
    const decalagePercent = decalageMonths * DECALAGE_RATE;
    const gross = Math.max(0, monthlyInitial * (1 - decalagePercent));
    cumulative += gross;
    rows.push({ month: m, gross: Math.round(gross * 100) / 100, cumulative: Math.round(cumulative * 100) / 100, decalagePercent: Math.round(decalagePercent * 100) });
  }

  return {
    monthlyInitial: Math.round(monthlyInitial * 100) / 100,
    duration,
    rows,
    totalGross: Math.round(cumulative * 100) / 100,
    eligible,
  };
}

// ─── Lightweight per-municipality IRPEF impact calculator ────────────────────
export interface MunicipalityTaxResult {
 italianTaxableBaseEUR: number;
 irpefGross: number;
 addizionaleRegionale: number;
 addizionaleComunale: number;
 totalAddizionali: number;
 deductions: number;
 irpefNet: number;
 swissTaxCHF: number;
 swissTaxCredit: number;
 finalItalianTaxEUR: number;
 totalTaxEUR: number;
}

/**
 * Calculate the Lombardia regional addizionale using progressive brackets.
 * The tax is applied marginally per bracket (like IRPEF scaglioni).
 */
export function calculateLombardiaRegionale(taxableBaseEUR: number): number {
 let remaining = Math.max(0, taxableBaseEUR);
 let tax = 0;
 let prevLimit = 0;
 for (const bracket of LOMBARDIA_ADDIZIONALE_REGIONALE) {
 const bracketWidth = bracket.upTo === Infinity ? remaining : bracket.upTo - prevLimit;
 const taxableInBracket = Math.min(remaining, bracketWidth);
 tax += taxableInBracket * bracket.rate;
 remaining -= taxableInBracket;
 prevLimit = bracket.upTo;
 if (remaining <= 0) break;
 }
 return tax;
}

/**
 * Lightweight IRPEF calculation for a new frontaliere in a given municipality.
 * Used to compare tax impact across municipalities without running the full simulation.
 */
export function calculateMunicipalityTaxImpact(
 annualIncomeCHF: number,
 exchangeRate: number,
 addizionaleComunalePercent: number, // e.g. 0.8 means 0.8%
 fascia: '1' | '1A' | '2',
 age: number = 35,
): MunicipalityTaxResult {
 const { avsRate, acRate, laaRate, ijmRate, lppRate25_34, lppRate35_44, lppRate45_54, lppRate55_plus, itWorkDeduction } = DEFAULT_TECH_PARAMS;

 // LPP rate by age
 const lppRate = age < 25 ? 0 : age <= 34 ? lppRate25_34 : age <= 44 ? lppRate35_44 : age <= 54 ? lppRate45_54 : lppRate55_plus;
 const totalSocialRate = avsRate + acRate + laaRate + ijmRate + lppRate;
 const socialDeductionsCHF = annualIncomeCHF * totalSocialRate;
 const socialDeductionsEUR = socialDeductionsCHF * exchangeRate;

 // Gross income in EUR
 const grossIncomeEUR = annualIncomeCHF * exchangeRate;

 // Franchigia: €10k for all frontalieri (Art. 1 c.175 L.147/2013, modified by Art. 4 L.83/2023)
 const franchigia = FRANCHIGIA_NUOVI_FRONTALIERI;
 const distanceZone = (fascia === '1' || fascia === '1A') ? 'WITHIN_20KM' : 'OVER_20KM';

 // Italian taxable base
 const italianTaxableBaseEUR = Math.max(0, grossIncomeEUR - socialDeductionsEUR - franchigia);

 // IRPEF gross (2026 scaglioni)
 const irpefGross = calculateIrpefGross(italianTaxableBaseEUR);

 // Addizionali
 const addizionaleRegionale = calculateLombardiaRegionale(italianTaxableBaseEUR);
 const addizionaleComunale = italianTaxableBaseEUR * (addizionaleComunalePercent / 100);
 const totalAddizionali = addizionaleRegionale + addizionaleComunale;

 // Progressive work deduction (Art. 13 TUIR) — single, no children baseline
 const deductions = calculateProgressiveWorkDeduction(italianTaxableBaseEUR);

 // IRPEF net before Swiss credit
 const irpefNet = Math.max(0, irpefGross + totalAddizionali - deductions);

 // Swiss withholding tax (source tax)
 // For new frontalieri within 20km: 80% stays in CH, 20% returned to IT
 // For over 20km: 100% in CH
 const ticinoRate = getTicinoTaxRate(annualIncomeCHF, 'SINGLE', 0, false);
 const swissTaxCHF = annualIncomeCHF * ticinoRate.rate;
 const chTaxShare = distanceZone === 'WITHIN_20KM' ? NEW_FRONTIER_WITHIN_20KM_CH_SHARE : 1.0;
 const paidSourceTaxEUR = (swissTaxCHF * chTaxShare) * exchangeRate;

 // Proportional foreign tax credit per Art. 165 c.10 TUIR + Ris. 38/E/2017
 const swissTaxCredit = calculateProportionalTaxCredit(paidSourceTaxEUR, italianTaxableBaseEUR, grossIncomeEUR);
 const finalItalianTaxEUR = Math.max(0, irpefNet - swissTaxCredit);

 // Total tax burden in EUR (Swiss portion paid + Italian portion)
 const swissTaxEUR = swissTaxCHF * exchangeRate;
 const totalTaxEUR = swissTaxEUR + finalItalianTaxEUR;

 return {
 italianTaxableBaseEUR,
 irpefGross,
 addizionaleRegionale,
 addizionaleComunale,
 totalAddizionali,
 deductions,
 irpefNet,
 swissTaxCHF,
 swissTaxCredit,
 finalItalianTaxEUR,
 totalTaxEUR,
 };
}

// ─── Seasonal (part-year work + NASpI) scenario calculator ───────────────────
/**
 * Annual deduction cap for voluntary contributions to a "fondo pensione
 * complementare" (Art. 8 co.4 D.Lgs. 252/2005). Raised from €5'164,57 (fixed
 * since 2007) to €5'300 from FY2026 by Legge di Bilancio 2026 (L. 199/2025,
 * comma 201) — confirm against current Agenzia Entrate guidance before relying on it,
 * since this cap can change again with future budget laws.
 */
export const PENSION_FUND_DEDUCTION_CAP_EUR = 5300;

export interface SeasonalScenarioInput {
  grossMonthlyCHF: number;
  monthsWorked: number;
  monthsOnNaspi: number;
  /** Months contributed in CH in the last 4 years — feeds the NASpI duration/eligibility check. */
  contributedMonthsLast4Years: number;
  /** Months of a PRIOR NASpI already received within the same 4-year reference window. */
  monthsAlreadyIndemnifiedInQuadriennio: number;
  age: number;
  maritalStatus: 'SINGLE' | 'MARRIED' | 'DIVORCED' | 'WIDOWED';
  spouseWorks: boolean;
  children: number;
  /** Scoped to the post-2024-Accordo "nuovo frontaliere" concurrent-taxation regime only. */
  distanceZone: 'WITHIN_20KM' | 'OVER_20KM';
  /** e.g. 0.55 for a 0.55% addizionale comunale IRPEF. */
  addizionaleComunalePercent: number;
  exchangeRate: number;
  /** Optional voluntary contribution to a fondo pensione (EUR/year), scenario 3 in the seasonal-vs-annual plan. */
  pensionContributionEUR?: number;
}

export interface SeasonalScenarioResult {
  grossWorkedCHF: number;
  swissSocialContributionsCHF: number;
  swissSourceTaxCHF: number;
  netSwissSalaryCHF: number;
  naspiMonthlyEUR: number;
  naspiEligibleMonths: number;
  naspiMonthsPaid: number;
  naspiShortfallMonths: number;
  naspiTotalGrossEUR: number;
  frontaliereTaxableBaseEUR: number;
  combinedTaxableBaseEUR: number;
  irpefGrossEUR: number;
  addizionaleRegionaleEUR: number;
  addizionaleComunaleEUR: number;
  workDeductionEUR: number;
  maritalDeductionEUR: number;
  childrenDeductionEUR: number;
  pensionDeductionEUR: number;
  pensionContributionCashOutEUR: number;
  swissTaxCreditEUR: number;
  finalItalianTaxEUR: number;
  netAnnualEUR: number;
  netMonthlyEquivalentEUR: number;
}

/**
 * Compare a full year of CH frontaliere work against a part-year scenario
 * where the remaining months are covered by NASpI (Italian unemployment
 * benefit), with an optional voluntary fondo pensione contribution.
 *
 * Scoped to the "nuovo frontaliere" (post-17/7/2023 Accordo) concurrent-taxation
 * regime only — the "vecchio frontaliere" exclusive-CH-taxation regime has a
 * structurally different Italian tax treatment (NASpI would still be Italian-
 * taxable even though the CH salary is not) and is out of scope for this tool.
 *
 * Reuses the same pure tax primitives as `calculateSimulation`'s NEW-frontier
 * branch (franchigia, IRPEF brackets, Lombardia addizionale, proportional
 * Swiss tax credit) so the two engines never drift apart — the boundary case
 * `monthsWorked=12, monthsOnNaspi=0` must reduce to the same combined taxable
 * base and net figure as `calculateSimulation` (see
 * tests/calculationService.test.ts).
 *
 * Swiss source tax uses the ANNUALIZED monthly salary to pick the withholding
 * bracket (as Swiss "imposta alla fonte" tables always do) but applies that
 * rate only to the ACTUAL gross earned during the worked months — the two
 * coincide only when monthsWorked === 12.
 */
export function calculateSeasonalScenario(input: SeasonalScenarioInput): SeasonalScenarioResult {
  const {
    grossMonthlyCHF, monthsWorked, monthsOnNaspi, contributedMonthsLast4Years,
    monthsAlreadyIndemnifiedInQuadriennio, age, maritalStatus, spouseWorks, children,
    distanceZone, addizionaleComunalePercent, exchangeRate,
    pensionContributionEUR = 0,
  } = input;

  const { avsRate, acRate, laaRate, ijmRate, lppRate25_34, lppRate35_44, lppRate45_54, lppRate55_plus } = DEFAULT_TECH_PARAMS;
  const lppRate = age < 25 ? 0 : age <= 34 ? lppRate25_34 : age <= 44 ? lppRate35_44 : age <= 54 ? lppRate45_54 : lppRate55_plus;

  // ── Swiss side: actual gross earned in the worked months ──
  const grossWorkedCHF = grossMonthlyCHF * monthsWorked;
  const annualizedGrossCHF = grossMonthlyCHF * 12; // for bracket lookups only
  // Family allowance is paid per month actually employed — prorated here (unlike
  // calculateSimulation's always-full-year convention) since this function explicitly
  // models a partial working year.
  const familyAllowanceCHF = children * SWISS_CHILD_ALLOWANCE_ANNUAL * (monthsWorked / 12);

  const avsAmount = grossWorkedCHF * avsRate;
  const acAmount = Math.min(grossWorkedCHF, 148200) * acRate;
  const laaAmount = grossWorkedCHF * laaRate;
  const ijmAmount = grossWorkedCHF * ijmRate;
  const lppAmount = grossWorkedCHF * lppRate;
  const swissSocialContributionsCHF = avsAmount + acAmount + laaAmount + ijmAmount + lppAmount;

  const { rate: baseRate, tableCode } = getTicinoTaxRate(annualizedGrossCHF, maritalStatus, children, spouseWorks);
  const effectiveTaxRateCH = adjustRateForChildren(baseRate, tableCode, children);
  // New frontalieri within 20km: only 80% of the ordinary source-tax rate is
  // withheld in CH (Accordo 2024 concurrent-taxation split) — applied once,
  // upfront, matching calculateSimulation's convention (taxWithheldInCH_CHF,
  // line 116) so every downstream figure (net CH salary, displayed source
  // tax, IT tax credit) is consistent with the actual withholding.
  const chTaxShare = distanceZone === 'WITHIN_20KM' ? NEW_FRONTIER_WITHIN_20KM_CH_SHARE : 1.0;
  const swissSourceTaxCHF = grossWorkedCHF * effectiveTaxRateCH * chTaxShare; // family allowance is source-tax-exempt in CH
  const netSwissSalaryCHF = grossWorkedCHF + familyAllowanceCHF - swissSocialContributionsCHF - swissSourceTaxCHF;

  const grossWorkedEUR = grossWorkedCHF * exchangeRate;
  const allowanceEUR = familyAllowanceCHF * exchangeRate;
  const socialEUR = swissSocialContributionsCHF * exchangeRate;
  const paidSourceTaxEUR = swissSourceTaxCHF * exchangeRate;

  // ── NASpI for the non-worked months ──
  const naspi = calculateNaspi(grossMonthlyCHF, contributedMonthsLast4Years, age, exchangeRate, monthsAlreadyIndemnifiedInQuadriennio);
  const naspiEligibleMonths = naspi.duration;
  const naspiMonthsPaid = Math.min(monthsOnNaspi, naspiEligibleMonths);
  const naspiShortfallMonths = Math.max(0, monthsOnNaspi - naspiEligibleMonths);
  const naspiTotalGrossEUR = naspi.rows.slice(0, naspiMonthsPaid).reduce((sum, r) => sum + r.gross, 0);

  // ── Italian side: franchigia applies only to the frontaliere-sourced base (not NASpI) ──
  const frontaliereTaxableBaseEUR = Math.max(0, grossWorkedEUR + allowanceEUR - socialEUR - FRANCHIGIA_NUOVI_FRONTALIERI);
  const combinedTaxableBaseEUR = frontaliereTaxableBaseEUR + naspiTotalGrossEUR;

  const irpefGrossEUR = calculateIrpefGross(combinedTaxableBaseEUR);
  const addizionaleRegionaleEUR = calculateLombardiaRegionale(combinedTaxableBaseEUR);
  const addizionaleComunaleEUR = combinedTaxableBaseEUR * (addizionaleComunalePercent / 100);
  const workDeductionEUR = calculateProgressiveWorkDeduction(combinedTaxableBaseEUR);
  const maritalDeductionEUR = (maritalStatus === 'MARRIED' && !spouseWorks) ? 690 : 0;
  const childrenDeductionEUR = children * 950;
  const pensionDeductionEUR = Math.min(Math.max(0, pensionContributionEUR), PENSION_FUND_DEDUCTION_CAP_EUR);

  const itLiabilityGross = Math.max(0, irpefGrossEUR + addizionaleRegionaleEUR + addizionaleComunaleEUR - workDeductionEUR - maritalDeductionEUR - childrenDeductionEUR - pensionDeductionEUR);
  const swissTaxCreditEUR = calculateProportionalTaxCredit(paidSourceTaxEUR, frontaliereTaxableBaseEUR, grossWorkedEUR + allowanceEUR);
  const finalItalianTaxEUR = Math.max(0, itLiabilityGross - swissTaxCreditEUR);

  const netAnnualEUR = grossWorkedEUR + allowanceEUR - socialEUR - paidSourceTaxEUR + naspiTotalGrossEUR
    - finalItalianTaxEUR - Math.max(0, pensionContributionEUR);

  return {
    grossWorkedCHF,
    swissSocialContributionsCHF,
    swissSourceTaxCHF,
    netSwissSalaryCHF,
    naspiMonthlyEUR: naspi.monthlyInitial,
    naspiEligibleMonths,
    naspiMonthsPaid,
    naspiShortfallMonths,
    naspiTotalGrossEUR,
    frontaliereTaxableBaseEUR,
    combinedTaxableBaseEUR,
    irpefGrossEUR,
    addizionaleRegionaleEUR,
    addizionaleComunaleEUR,
    workDeductionEUR,
    maritalDeductionEUR,
    childrenDeductionEUR,
    pensionDeductionEUR,
    pensionContributionCashOutEUR: Math.max(0, pensionContributionEUR),
    swissTaxCreditEUR,
    finalItalianTaxEUR,
    netAnnualEUR,
    netMonthlyEquivalentEUR: netAnnualEUR / 12,
  };
}