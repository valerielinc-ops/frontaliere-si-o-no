export interface ExpenseItem {
  id: string;
  label: string;
  amount: number;
  frequency: 'MONTHLY' | 'ANNUAL';
  tooltip?: string;
}

export interface SimulationInputs {
  annualIncomeCHF: number;
  familyMembers: number;
  children: number;
  healthInsuranceCHF: number;
  frontierWorkerType: 'NEW' | 'OLD';
  distanceZone: 'WITHIN_20KM' | 'OVER_20KM';
  customExchangeRate: number;
  monthsBasis: number;
  age: number;
  maritalStatus: 'SINGLE' | 'MARRIED' | 'DIVORCED' | 'WIDOWED';
  sex: 'M' | 'F';
  spouseWorks: boolean;
  // Custom Expenses
  expensesCH: ExpenseItem[];
  expensesIT: ExpenseItem[];
  // Technical Parameters
  avsRate: number;
  acRate: number;
  laaRate: number;
  ijmRate: number;
  lppRate25_34: number;
  lppRate35_44: number;
  lppRate45_54: number;
  lppRate55_plus: number;
  itAddizionaleRate: number;
  itWorkDeduction: number;
  // Experimental Features
  enableOldFrontierHealthTax: boolean;
  ssnHealthTaxPercentage: number;
}

export interface TaxBreakdownItem {
  label: string;
  amount: number;
  amountEUR?: number;
  percentage: number;
  description?: string;
}

export interface TaxResult {
  grossIncome: number;
  familyAllowance: number;
  socialContributions: number;
  taxableIncome: number;
  taxes: number;
  healthInsurance: number;
  customExpensesTotal: number;
  netIncomeAnnual: number;
  netIncomeMonthly: number;
  swissNetIncomeMonthlyCHF?: number;
  currency: 'CHF' | 'EUR';
  breakdown: TaxBreakdownItem[];
  details: {
    regime: string;
    effectiveRate: number;
    source: string;
    sourceUrl?: string;
    franchigiaEUR?: number;
    notes: string[];
    irpefDetails?: {
      taxableBaseEUR: number;
      grossTaxEUR: number;
      deductionsEUR: number;
      addizionaliEUR: number;
      creditSwissTaxEUR: number;
      finalNetTaxEUR: number;
    };
  };
}

export interface SimulationResult {
  chResident: TaxResult;
  itResident: TaxResult;
  savingsCHF: number;
  savingsEUR: number;
  exchangeRate: number;
  monthsBasis: number;
}