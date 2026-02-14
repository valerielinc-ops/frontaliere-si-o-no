import { SimulationInputs, SimulationResult, TaxResult, TaxBreakdownItem, ExpenseItem } from '../types';
import { FRANCHIGIA_NUOVI_FRONTALIERI, SWISS_CHILD_ALLOWANCE_ANNUAL, LINKS } from '../constants';

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

const getTicinoTaxRate = (income: number, marital: string, children: number, spouseWorks: boolean): { rate: number, table: string, tableCode: string } => {
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

const adjustRateForChildren = (baseRate: number, tableCode: string, children: number): number => {
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

export const calculateSimulation = (inputs: SimulationInputs): SimulationResult => {
  const { annualIncomeCHF, children, healthInsuranceCHF, frontierWorkerType, customExchangeRate, monthsBasis, distanceZone, age, maritalStatus, spouseWorks, avsRate, acRate, laaRate, ijmRate, lppRate25_34, lppRate35_44, lppRate45_54, lppRate55_plus, itAddizionaleRate, itWorkDeduction, expensesCH, expensesIT, enableOldFrontierHealthTax, ssnHealthTaxPercentage } = inputs;
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

  const grossTotalCH = annualIncomeCHF + annualFamilyAllowanceCHF;
  const netIncomeAnnualCH = grossTotalCH - totalSocialDeductions - totalTaxCH - healthAnnualCH - expensesTotalCH;

  const chResidentResult: TaxResult = {
    grossIncome: annualIncomeCHF, familyAllowance: annualFamilyAllowanceCHF, socialContributions: totalSocialDeductions, taxableIncome: annualIncomeCHF, taxes: totalTaxCH, healthInsurance: healthAnnualCH, customExpensesTotal: expensesTotalCH, netIncomeAnnual: netIncomeAnnualCH, netIncomeMonthly: netIncomeAnnualCH / monthsBasis, currency: 'CHF',
    breakdown: [
      { label: 'calc.workIncome', amount: annualIncomeCHF, percentage: (annualIncomeCHF/grossTotalCH)*100, description: 'calc.workIncomeDesc' },
      { label: 'calc.familyAllowance', amount: annualFamilyAllowanceCHF, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100, description: 'calc.familyAllowanceDesc' },
      { label: 'calc.socialContributions', amount: -(avsAmount + acAmount + laaAmount + ijmAmount), percentage: ((avsAmount + acAmount + laaAmount + ijmAmount)/grossTotalCH)*100, description: 'calc.socialContributionsDesc' },
      { label: 'calc.pension', amount: -lppAmount, percentage: (lppAmount/grossTotalCH)*100, description: 'calc.pensionDesc' },
      { label: 'calc.totalTaxes', amount: -totalTaxCH, percentage: (totalTaxCH/grossTotalCH)*100, description: 'calc.totalTaxesDesc' },
      { label: 'calc.healthInsurance', amount: -healthAnnualCH, percentage: (healthAnnualCH/grossTotalCH)*100, description: `calc.healthInsuranceDesc|${healthInsuranceCHF}|${inputs.familyMembers}` },
      { label: 'calc.personalExpenses', amount: -expensesTotalCH, percentage: (expensesTotalCH/grossTotalCH)*100, description: 'calc.personalExpensesDesc' },
      { label: 'calc.netAnnualIncome', amount: netIncomeAnnualCH, percentage: (netIncomeAnnualCH/grossTotalCH)*100, description: `calc.netIncomeDescCH|${(effectiveTaxRateCH*100).toFixed(1)}|${tableCode}` },
    ],
    details: { regime: "calc.regime.chResident", effectiveRate: (totalTaxCH / grossTotalCH) * 100, source: appliedTable, notes: [`calc.notes.standardRates`, `calc.notes.taxTable|${tableCode}`] }
  };

  let chTaxShare = (frontierWorkerType === 'NEW' && distanceZone === 'WITHIN_20KM') ? 0.8 : 1.0;
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
      description: notesIT.join(". ")
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
    franchigiaUsed = (distanceZone === 'WITHIN_20KM') ? FRANCHIGIA_NUOVI_FRONTALIERI : 0;
    const italianTaxableBaseEUR = Math.max(0, grossIncomeEUR + allowanceEUR - socialEUR - franchigiaUsed);
    let irpefGross = 0;
    if (italianTaxableBaseEUR <= 28000) irpefGross = italianTaxableBaseEUR * 0.23;
    else if (italianTaxableBaseEUR <= 50000) irpefGross = (28000 * 0.23) + ((italianTaxableBaseEUR - 28000) * 0.35);
    else irpefGross = (28000 * 0.23) + (22000 * 0.35) + ((italianTaxableBaseEUR - 50000) * 0.43);

    const itDeductions = itWorkDeduction + (maritalStatus === 'MARRIED' && !spouseWorks ? 690 : 0) + (children * 950);
    const addizionali = italianTaxableBaseEUR * itAddizionaleRate;
    const itLiability = Math.max(0, irpefGross + addizionali - itDeductions); 
    finalItTaxEUR = Math.max(0, itLiability - paidSourceTaxEUR);
    const finalItTaxCHF = finalItTaxEUR / EXCHANGE_RATE;

    irpefDetails = { taxableBaseEUR: italianTaxableBaseEUR, grossTaxEUR: irpefGross, deductionsEUR: itDeductions, addizionaliEUR: addizionali, creditSwissTaxEUR: paidSourceTaxEUR, finalNetTaxEUR: finalItTaxEUR };
    notesIT = ["calc.regime.newFrontier", "calc.notes.concurrentTax", franchigiaUsed > 0 ? "calc.notes.franchiseApplied" : "calc.notes.noFranchise"];
    
    itBreakdown = [
      { label: 'calc.grossIncome', amount: annualIncomeCHF, amountEUR: grossIncomeEUR, percentage: (annualIncomeCHF/grossTotalCH)*100, description: 'calc.grossIncomeDesc' },
      { label: 'calc.familyAllowanceCH', amount: annualFamilyAllowanceCHF, amountEUR: allowanceEUR, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100, description: 'calc.familyAllowanceCHDesc2' },
      { label: 'calc.socialContributionsCH', amount: -totalSocialDeductions, amountEUR: -socialEUR, percentage: (totalSocialDeductions/grossTotalCH)*100, description: 'calc.socialContributionsCHDeductibleDesc' },
      { label: `calc.sourceCHPartial|${Math.round(chTaxShare * 100)}`, amount: -taxWithheldInCH_CHF, amountEUR: -paidSourceTaxEUR, percentage: (taxWithheldInCH_CHF/grossTotalCH)*100, description: 'calc.sourceCHPartialDesc' },
      { label: 'calc.irpefBalance', amount: -finalItTaxCHF, amountEUR: -finalItTaxEUR, percentage: (finalItTaxCHF/grossTotalCH)*100, description: 'calc.irpefBalanceDesc' },
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
    description: notesIT.join(". ")
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