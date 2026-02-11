export interface SimulationInputs {
  annualIncomeCHF: number;
  familyMembers: number;
  children: number;
  healthInsuranceCHF: number;
  frontierWorkerType: 'NEW' | 'OLD'; // NEW = Post 2023, OLD = Ante 2023 (20km)
  distanceZone: 'WITHIN_20KM' | 'OVER_20KM';
  customExchangeRate: number;
  monthsBasis: number; // 12, 13, 14
  // New Advanced Fields
  age: number;
  maritalStatus: 'SINGLE' | 'MARRIED' | 'DIVORCED' | 'WIDOWED';
  sex: 'M' | 'F';
  spouseWorks: boolean; // New field to distinguish Table B vs C
}

export interface TaxBreakdownItem {
  label: string;
  amount: number; // Always in CHF
  amountEUR?: number; // Optional EUR equivalent for Italy side
  percentage: number; // Relative to Gross Income
  description?: string;
}

export interface TaxResult {
  grossIncome: number;
  familyAllowance: number;
  socialContributions: number; // AVS/AI/IPG + LPP
  taxableIncome: number;
  taxes: number; // Total Tax
  healthInsurance: number;
  netIncomeAnnual: number;
  netIncomeMonthly: number;
  swissNetIncomeMonthlyCHF?: number; // Specific for Frontaliere: Net in CHF before IT tax
  currency: 'CHF' | 'EUR';
  breakdown: TaxBreakdownItem[]; // Detailed list
  details: {
    regime: string;
    effectiveRate: number;
    source: string;
    sourceUrl?: string;
    franchigiaEUR?: number; // Added to track if the 10k bonus was applied
    notes: string[];
  };
}

export interface SimulationResult {
  chResident: TaxResult;
  itResident: TaxResult; // Now normalized to CHF for display, but contains breakdown with EUR
  savingsCHF: number;
  savingsEUR: number;
  exchangeRate: number;
  monthsBasis: number;
}