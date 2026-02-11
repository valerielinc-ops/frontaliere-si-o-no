import { SimulationInputs, SimulationResult, TaxResult, TaxBreakdownItem } from '../types';
import { FRANCHIGIA_NUOVI_FRONTALIERI, SWISS_CHILD_ALLOWANCE_ANNUAL, LINKS } from '../constants';

// --- DATA: TAX TABLES 2026 (Approximation via Interpolation Points) ---
// Source: Canton Ticino "Aliquote di imposta alla fonte" 2026 PDF
// Format: [AnnualIncomeCHF, RatePercentage]

// Table A: Single / Persone sole
const TABLE_A_POINTS = [
  [0, 0], 
  [17000, 0.20], 
  [25000, 2.00], 
  [30000, 3.20], 
  [40000, 5.20], 
  [50000, 6.00], 
  [60000, 8.50], 
  [80000, 11.30], 
  [100000, 13.20], 
  [120000, 14.90],
  [130000, 15.70],
  [135000, 16.00], 
  [140000, 16.50], 
  [150000, 17.20], 
  [180000, 18.90],
  [200000, 19.40],
  [250000, 22.80], 
  [300000, 24.50],
  [500000, 28.30], 
  [1000000, 31.50]
];

// Table B: Married Sole Earner / Coniugi reddito unico
// (Often much lower rates for same income)
const TABLE_B_POINTS = [
  [0, 0],
  [25000, 0.30],
  [30000, 0.70],
  [40000, 1.10],
  [50000, 1.50],
  [60000, 2.50],
  [80000, 5.10],
  [100000, 8.70],
  [120000, 10.70],
  [140000, 12.80],
  [160000, 14.40],
  [180000, 15.60],
  [200000, 16.50],
  [250000, 20.20],
  [300000, 22.80],
  [500000, 26.50]
];

// Table C: Married Double Earner / Coniugi doppio reddito
// (Applied to individual income, rates similar to A but slightly different curve)
const TABLE_C_POINTS = [
  [0, 0],
  [20000, 0.20],
  [30000, 1.90],
  [40000, 4.40],
  [50000, 6.20],
  [60000, 8.20],
  [80000, 11.20],
  [100000, 13.10],
  [120000, 14.90],
  [140000, 16.40],
  [160000, 17.60],
  [180000, 18.90],
  [200000, 19.50],
  [250000, 22.90],
  [300000, 25.10],
  [500000, 28.50]
];

// Table H: Single Parent / Monoparentale (With children)
// (Much more favorable than A)
const TABLE_H_POINTS = [
  [0, 0],
  [35000, 0.20],
  [40000, 1.10],
  [50000, 1.80],
  [60000, 2.50],
  [80000, 4.70],
  [100000, 7.10],
  [120000, 9.30],
  [140000, 11.70],
  [160000, 13.50],
  [180000, 14.90],
  [200000, 16.00],
  [250000, 19.40],
  [300000, 21.70]
];

const interpolate = (value: number, points: number[][]): number => {
  if (value <= points[0][0]) return points[0][1];
  if (value >= points[points.length - 1][0]) return points[points.length - 1][1];

  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (value >= x0 && value < x1) {
      // Linear interpolation
      return y0 + (value - x0) * (y1 - y0) / (x1 - x0);
    }
  }
  return 0;
};

// Helper to determine which table to use
const getTicinoTaxRate = (
  income: number, 
  marital: string, 
  children: number, 
  spouseWorks: boolean
): { rate: number, table: string, tableCode: string } => {
  
  // 1. Single / Divorced / Widowed
  if (['SINGLE', 'DIVORCED', 'WIDOWED'].includes(marital)) {
    if (children > 0) {
      // Tabella H: Monoparentale
      return { 
        rate: interpolate(income, TABLE_H_POINTS) / 100, 
        table: "Tabella H (Monoparentale)",
        tableCode: "H"
      };
    } else {
      // Tabella A: Persone sole
      return { 
        rate: interpolate(income, TABLE_A_POINTS) / 100, 
        table: "Tabella A (Persone sole)",
        tableCode: "A"
      };
    }
  }

  // 2. Married
  if (marital === 'MARRIED') {
    if (spouseWorks) {
      // Tabella C: Doppio reddito
      return { 
        rate: interpolate(income, TABLE_C_POINTS) / 100, 
        table: "Tabella C (Doppio reddito)",
        tableCode: "C"
      };
    } else {
      // Tabella B: Reddito unico
      return { 
        rate: interpolate(income, TABLE_B_POINTS) / 100, 
        table: "Tabella B (Reddito unico)",
        tableCode: "B"
      };
    }
  }

  // Fallback
  return { rate: 0.10, table: "Standard", tableCode: "A" };
};

// Adjust deduction for children in Source Tax (Barème)
// Note: In Ticino Source Tax tables (A, B, C, H), the rate is often determined by the number of children columns (A0, A1, B0, B1...).
// The interpolated tables above (A_POINTS, B_POINTS...) approximate the "0 children" column (or H1 for H).
// We need a modifier for children.
// Analyzing the PDF:
// Table A: Child columns A1, A2... are identical to A0. Children do not reduce rate in Table A! (Verified in PDF).
// Table B: Children significantly reduce rate. E.g. 100k: B0=8.7%, B1=6.0%, B2=3.7%.
// Table C: Children reduce rate. E.g. 100k: C0=13.1%, C1=10.9%, C2=8.9%.
// Table H: H1 is base. H2, H3 reduce.
// Simplified Child Deduction Logic for this simulation:
const adjustRateForChildren = (baseRate: number, tableCode: string, children: number): number => {
  if (children === 0) return baseRate;
  
  // Correction factors based on visual analysis of PDF delta between columns
  let discountPerChild = 0;

  if (tableCode === 'A') {
    // Table A: No discount for children in the rate itself (Verified A0=A1=A2).
    // Usually single parents move to Table H.
    return baseRate;
  }
  
  if (tableCode === 'H') {
    // H1 to H2: ~1.5% drop at 100k.
    discountPerChild = 0.015; 
  }
  
  if (tableCode === 'B') {
    // B0(8.7) -> B1(6.0) -> B2(3.7) at 100k. Huge drop (~2.5% per child).
    discountPerChild = 0.025;
  }
  
  if (tableCode === 'C') {
    // C0(13.1) -> C1(10.9) -> C2(8.9) at 100k. Drop ~2.2%.
    discountPerChild = 0.021;
  }

  const discount = discountPerChild * children;
  return Math.max(0.005, baseRate - discount); // Min tax 0.5%
};

export const calculateSimulation = (inputs: SimulationInputs): SimulationResult => {
  const { 
    annualIncomeCHF, 
    familyMembers, 
    children, 
    healthInsuranceCHF, 
    frontierWorkerType, 
    customExchangeRate, 
    monthsBasis, 
    distanceZone,
    age,
    maritalStatus,
    spouseWorks
  } = inputs;
  const EXCHANGE_RATE = customExchangeRate;

  // --- 1. Swiss Social Contributions ---
  // Based on Payslip analysis:
  // AVS/AI/IPG: 5.3%
  // AC: 1.1%
  // LAA (NBU): ~0.66% - 1.5% (Payslip says 0.66%)
  // IJM (Maladie Loss): ~0.79% (Payslip says 0.79%)
  // LPP: Varies by age.
  
  const avsRate = 0.053; 
  const acRate = 0.011;
  const laaRate = 0.0066; // Matches payslip
  const ijmRate = 0.0079; // Matches payslip

  // LPP (2nd Pillar) - Standard rates
  let lppRate = 0.035; // Default low
  if (age >= 25 && age <= 34) lppRate = 0.035; // Approx 7% / 2
  if (age >= 35 && age <= 44) lppRate = 0.05;  // Approx 10% / 2
  if (age >= 45 && age <= 54) lppRate = 0.075; // Approx 15% / 2
  if (age >= 55) lppRate = 0.09;               // Approx 18% / 2

  const avsAmount = annualIncomeCHF * avsRate;
  const acAmount = Math.min(annualIncomeCHF, 148200) * acRate;
  const laaAmount = annualIncomeCHF * laaRate;
  const ijmAmount = annualIncomeCHF * ijmRate;
  const lppAmount = annualIncomeCHF * lppRate; 

  const totalSocialDeductions = avsAmount + acAmount + laaAmount + ijmAmount + lppAmount;
  
  // Family Allowance
  const annualFamilyAllowanceCHF = children * SWISS_CHILD_ALLOWANCE_ANNUAL;

  // --- 2. Tax Calculation ---
  const taxableBaseCHF = annualIncomeCHF; // Source tax tables apply to Gross Income (Lordo)
  
  // Get Base Rate from Tables
  const { rate: baseRate, table: appliedTable, tableCode } = getTicinoTaxRate(taxableBaseCHF, maritalStatus, children, spouseWorks);
  
  // Apply Child Reduction
  const effectiveTaxRateCH = adjustRateForChildren(baseRate, tableCode, children);

  const totalTaxCH = taxableBaseCHF * effectiveTaxRateCH;
  const healthAnnualCH = healthInsuranceCHF * 12;

  const grossTotalCH = annualIncomeCHF + annualFamilyAllowanceCHF;
  const netIncomeAnnualCH = grossTotalCH - totalSocialDeductions - totalTaxCH - healthAnnualCH;

  const chResidentResult: TaxResult = {
    grossIncome: annualIncomeCHF,
    familyAllowance: annualFamilyAllowanceCHF,
    socialContributions: totalSocialDeductions,
    taxableIncome: taxableBaseCHF,
    taxes: totalTaxCH,
    healthInsurance: healthAnnualCH,
    netIncomeAnnual: netIncomeAnnualCH,
    netIncomeMonthly: netIncomeAnnualCH / monthsBasis,
    currency: 'CHF',
    breakdown: [
      { label: 'Reddito da Lavoro', amount: annualIncomeCHF, percentage: (annualIncomeCHF/grossTotalCH)*100 },
      { label: 'Assegni Familiari', amount: annualFamilyAllowanceCHF, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100 },
      { label: 'Sociali (AVS/AC/LAA/IJM)', amount: -(avsAmount + acAmount + laaAmount + ijmAmount), percentage: ((avsAmount + acAmount + laaAmount + ijmAmount)/grossTotalCH)*100 },
      { label: 'Pensione (LPP)', amount: -lppAmount, percentage: (lppAmount/grossTotalCH)*100 },
      { label: 'Imposte Totali', amount: -totalTaxCH, percentage: (totalTaxCH/grossTotalCH)*100 },
      { label: 'Cassa Malati', amount: -healthAnnualCH, percentage: (healthAnnualCH/grossTotalCH)*100 },
    ],
    details: {
      regime: "Residente Ticinese",
      effectiveRate: (totalTaxCH / grossTotalCH) * 100,
      source: appliedTable,
      notes: [`Aliquote 2026`, `Tabella: ${tableCode}`]
    }
  };

  // --- 3. Scenario 2: FRONTALIERE ---
  
  // Determine Tax Share Withheld in CH
  let chTaxShare = 1.0;
  if (frontierWorkerType === 'NEW' && distanceZone === 'WITHIN_20KM') {
    chTaxShare = 0.8;
  }
  
  const taxWithheldInCH_CHF = totalTaxCH * chTaxShare;

  // NET CHF received (before IT tax)
  const swissNetCHFAnnual = grossTotalCH - totalSocialDeductions - taxWithheldInCH_CHF;
  const swissNetCHFMonthly = swissNetCHFAnnual / monthsBasis;

  const grossIncomeEUR = annualIncomeCHF * EXCHANGE_RATE;
  const allowanceEUR = annualFamilyAllowanceCHF * EXCHANGE_RATE;
  const socialEUR = totalSocialDeductions * EXCHANGE_RATE;
  const totalGrossEUR = grossIncomeEUR + allowanceEUR;

  let paidSourceTaxEUR = taxWithheldInCH_CHF * EXCHANGE_RATE;
  let finalItTaxEUR = 0;
  let notesIT: string[] = [];
  let itBreakdown: TaxBreakdownItem[] = [];
  let franchigiaUsed = 0;

  if (frontierWorkerType === 'OLD') {
    // Old Frontier: Pays only Swiss Tax (100% of it)
    // No extra Italian tax
    finalItTaxEUR = 0;
    itBreakdown = [
      { label: 'Reddito Lordo', amount: annualIncomeCHF, amountEUR: grossIncomeEUR, percentage: (annualIncomeCHF/grossTotalCH)*100 },
      { label: 'Assegni Familiari (CH)', amount: annualFamilyAllowanceCHF, amountEUR: allowanceEUR, percentage: (annualFamilyAllowanceCHF/grossTotalCH)*100 },
      { label: 'Contributi Sociali CH', amount: -totalSocialDeductions, amountEUR: -socialEUR, percentage: (totalSocialDeductions/grossTotalCH)*100 },
      { label: 'Imposta alla Fonte CH (100%)', amount: -taxWithheldInCH_CHF, amountEUR: -paidSourceTaxEUR, percentage: (taxWithheldInCH_CHF/grossTotalCH)*100 },
      { label: 'IRPEF Italia', amount: 0, amountEUR: 0, percentage: 0 },
    ];
    notesIT = ["Tassazione esclusiva in Svizzera (Accordo 1974)"];
  } else {
    // NEW Frontier
    let franchigia = (distanceZone === 'WITHIN_20KM') ? FRANCHIGIA_NUOVI_FRONTALIERI : 0;
    franchigiaUsed = franchigia;
    
    // Simple IRPEF estimation
    const italianTaxableBaseEUR = Math.max(0, grossIncomeEUR + allowanceEUR - socialEUR - franchigia);
    let irpefGross = 0;
    if (italianTaxableBaseEUR <= 28000) irpefGross = italianTaxableBaseEUR * 0.23;
    else if (italianTaxableBaseEUR <= 50000) irpefGross = (28000 * 0.23) + ((italianTaxableBaseEUR - 28000) * 0.35);
    else irpefGross = (28000 * 0.23) + (22000 * 0.35) + ((italianTaxableBaseEUR - 50000) * 0.43);

    const itDeductions = 1910 + (maritalStatus === 'MARRIED' ? 690 : 0) + (children * 950);
    const itLiability = Math.max(0, irpefGross + (italianTaxableBaseEUR * 0.02) - itDeductions); 
    
    finalItTaxEUR = Math.max(0, itLiability - paidSourceTaxEUR);
    const finalItTaxCHF = finalItTaxEUR / EXCHANGE_RATE;

    itBreakdown = [
      { label: 'Reddito Lordo', amount: annualIncomeCHF, amountEUR: grossIncomeEUR, percentage: (annualIncomeCHF/grossTotalCH)*100 },
      { label: 'Contributi Sociali CH', amount: -totalSocialDeductions, amountEUR: -socialEUR, percentage: (totalSocialDeductions/grossTotalCH)*100 },
      { label: `Fonte CH (${Math.round(chTaxShare * 100)}%)`, amount: -taxWithheldInCH_CHF, amountEUR: -paidSourceTaxEUR, percentage: (taxWithheldInCH_CHF/grossTotalCH)*100 },
      { label: 'IRPEF Italia (Saldo)', amount: -finalItTaxCHF, amountEUR: -finalItTaxEUR, percentage: (finalItTaxCHF/grossTotalCH)*100 },
    ];
    notesIT = ["Tassazione concorrente (Accordo 2023)", "Franchigia applicata se idoneo"];
  }

  const totalTaxIT_CHF = taxWithheldInCH_CHF + (finalItTaxEUR / EXCHANGE_RATE);
  const netAnnualIT_CHF = grossTotalCH - totalSocialDeductions - totalTaxIT_CHF;

  const itResidentResult: TaxResult = {
    grossIncome: annualIncomeCHF, 
    familyAllowance: annualFamilyAllowanceCHF,
    socialContributions: totalSocialDeductions,
    taxableIncome: taxableBaseCHF,
    taxes: totalTaxIT_CHF, 
    healthInsurance: 0,
    netIncomeAnnual: netAnnualIT_CHF,
    netIncomeMonthly: netAnnualIT_CHF / monthsBasis,
    swissNetIncomeMonthlyCHF: swissNetCHFMonthly,
    currency: 'CHF', 
    breakdown: itBreakdown,
    details: {
      regime: frontierWorkerType === 'OLD' ? "Vecchio Frontaliere" : "Nuovo Frontaliere",
      effectiveRate: (totalTaxIT_CHF / grossTotalCH) * 100,
      source: "Accordo Fiscale CH-IT",
      franchigiaEUR: franchigiaUsed,
      notes: notesIT
    }
  };

  const savingsCHF = netAnnualIT_CHF - netIncomeAnnualCH;

  return {
    chResident: chResidentResult,
    itResident: itResidentResult,
    savingsCHF: savingsCHF,
    savingsEUR: savingsCHF * EXCHANGE_RATE,
    exchangeRate: EXCHANGE_RATE,
    monthsBasis: monthsBasis
  };
};