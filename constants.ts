export const DEFAULT_EXCHANGE_RATE = 1.06;
export const FRANCHIGIA_NUOVI_FRONTALIERI = 10000;
export const SWISS_CHILD_ALLOWANCE_ANNUAL = 3000;
export const ITALY_CHILD_ALLOWANCE_ANNUAL_MIN = 684;

export const LINKS = {
  TI_TAX: "https://www4.ti.ch/dfe/dc/imposte/persone-fisiche/calcolatore-dimposta",
  IT_IRPEF: "https://www.agenziaentrate.gov.it/portale/imposta-sul-reddito-delle-persone-fisiche-irpef-aliquote-e-scaglioni",
};

export const DEFAULT_TECH_PARAMS = {
  avsRate: 0.053,
  acRate: 0.011,
  laaRate: 0.007,
  ijmRate: 0.008,
  lppRate25_34: 0.035,
  lppRate35_44: 0.05,
  lppRate45_54: 0.075,
  lppRate55_plus: 0.09,
  itAddizionaleRate: 0.02,
  itWorkDeduction: 1910,
};

export const PRESET_EXPENSES_CH = [
  { label: 'Affitto 2.5/3.5 Locali', amount: 1450, icon: 'Home' },
  { label: 'Spesa Alimentare', amount: 500, icon: 'ShoppingBasket' },
  { label: 'Internet & TV', amount: 80, icon: 'Wifi' },
  { label: 'Elettricità', amount: 50, icon: 'Zap' },
  { label: 'Trasporti/Abbonamento', amount: 80, icon: 'Bus' },
  { label: 'Leasing Auto', amount: 400, icon: 'Car' },
];

export const PRESET_EXPENSES_IT = [
  { label: 'Affitto/Mutuo', amount: 750, icon: 'Home' },
  { label: 'Spesa Alimentare', amount: 350, icon: 'ShoppingBasket' },
  { label: 'Internet Casa', amount: 30, icon: 'Wifi' },
  { label: 'Bollette Luce/Gas', amount: 120, icon: 'Zap' },
  { label: 'Benzina/Trasporti', amount: 150, icon: 'Fuel' },
  { label: 'Rata Auto', amount: 300, icon: 'Car' },
];

export const DEFAULT_INPUTS = {
  annualIncomeCHF: 100000,
  familyMembers: 3,
  children: 1,
  healthInsuranceCHF: 1200,
  frontierWorkerType: 'NEW' as const,
  distanceZone: 'WITHIN_20KM' as const,
  customExchangeRate: DEFAULT_EXCHANGE_RATE,
  monthsBasis: 12,
  age: 35,
  maritalStatus: 'SINGLE' as const,
  sex: 'M' as const,
  spouseWorks: false,
  expensesCH: [],
  expensesIT: [],
  // Spread technical defaults
  ...DEFAULT_TECH_PARAMS,
  // Experimental Features
  enableOldFrontierHealthTax: false
};

export const COLORS = {
  switzerland: '#0ea5e9',
  italy: '#ef4444',
  savings: '#10b981',
};