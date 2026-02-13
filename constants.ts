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
  { label: 'Internet & TV Svizzera', amount: 80, icon: 'Wifi' },
  { label: 'Cellulare Swisscom', amount: 45, icon: 'Smartphone' },
  { label: 'Elettricità & Riscaldamento', amount: 100, icon: 'Zap' },
  { label: 'Trasporti/Abbonamento TPL', amount: 80, icon: 'Bus' },
  { label: 'Leasing/Rata Auto', amount: 400, icon: 'Car' },
  { label: 'Tassa Rifiuti/Acqua', amount: 50, icon: 'Droplet' },
];

export const PRESET_EXPENSES_IT = [
  { label: 'Affitto/Mutuo', amount: 750, icon: 'Home' },
  { label: 'Spesa Alimentare', amount: 350, icon: 'ShoppingBasket' },
  { label: 'Internet Casa Fibra', amount: 30, icon: 'Wifi' },
  { label: 'Cellulare (Tim/Vodafone)', amount: 15, icon: 'Smartphone' },
  { label: 'Bollette Luce & Gas', amount: 120, icon: 'Zap' },
  { label: 'Benzina/Autostrada', amount: 150, icon: 'Fuel' },
  { label: 'Rata Auto/Assicurazione', amount: 300, icon: 'Car' },
  { label: 'Canone RAI', amount: 90, icon: 'Tv' },
  { label: 'IMU/TARI (se proprietari)', amount: 100, icon: 'Home' },
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
  enableOldFrontierHealthTax: false,
  ssnHealthTaxPercentage: 3
};

export const COLORS = {
  switzerland: '#0ea5e9',
  italy: '#ef4444',
  savings: '#10b981',
};