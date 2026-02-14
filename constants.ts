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

// Funzione per calcolare spese in base al numero di componenti
export const calculateDynamicExpenses = (familyMembers: number, target: 'CH' | 'IT') => {
  // Coefficienti per scalare le spese in base ai componenti
  const singleCoeff = 0.6; // Single person: 60% del base
  const coupleCoeff = 0.85; // Couple (2): 85% del base
  const familyCoeff = 1.0; // Family (3): 100% del base (default)
  const largeFamilyCoeff = 1.25; // Large family (4+): 125% del base
  
  const getCoeff = () => {
    if (familyMembers === 1) return singleCoeff;
    if (familyMembers === 2) return coupleCoeff;
    if (familyMembers === 3) return familyCoeff;
    return largeFamilyCoeff;
  };
  
  const coeff = getCoeff();
  
  if (target === 'CH') {
    return [
      { label: 'expenses.ch.rent', amount: Math.round(1450 * coeff), frequency: 'MONTHLY', icon: 'Home' },
      { label: 'expenses.ch.groceries', amount: Math.round(500 * coeff), frequency: 'MONTHLY', icon: 'ShoppingBasket' },
      { label: 'expenses.ch.internet', amount: 60, frequency: 'MONTHLY', icon: 'Wifi' },
      { label: 'expenses.ch.tvLicense', amount: 335, frequency: 'ANNUAL', icon: 'Tv', tooltip: 'expenses.ch.tvLicenseTooltip' },
      { label: 'expenses.ch.simMobile', amount: familyMembers === 1 ? 45 : Math.round(45 * Math.min(familyMembers, 3) * 0.7), frequency: 'MONTHLY', icon: 'Smartphone', tooltip: 'expenses.ch.simMobileTooltip' },
      { label: 'expenses.ch.electricity', amount: Math.round(100 * coeff), frequency: 'MONTHLY', icon: 'Zap' },
      { label: 'expenses.ch.transport', amount: 80, frequency: 'MONTHLY', icon: 'Bus' },
      { label: 'expenses.ch.carLease', amount: 400, frequency: 'MONTHLY', icon: 'Car' },
      { label: 'expenses.ch.wasteWater', amount: Math.round(50 * coeff), frequency: 'MONTHLY', icon: 'Droplet' },
    ];
  } else {
    return [
      { label: 'expenses.it.rent', amount: Math.round(750 * coeff), frequency: 'MONTHLY', icon: 'Home' },
      { label: 'expenses.it.groceries', amount: Math.round(350 * coeff), frequency: 'MONTHLY', icon: 'ShoppingBasket' },
      { label: 'expenses.it.internet', amount: 30, frequency: 'MONTHLY', icon: 'Wifi' },
      { label: 'expenses.it.simMobile', amount: familyMembers === 1 ? 15 : Math.round(15 * Math.min(familyMembers, 3) * 0.8), frequency: 'MONTHLY', icon: 'Smartphone', tooltip: 'expenses.it.simMobileTooltip' },
      { label: 'expenses.it.utilities', amount: Math.round(120 * coeff), frequency: 'MONTHLY', icon: 'Zap' },
      { label: 'expenses.it.fuel', amount: 150, frequency: 'MONTHLY', icon: 'Fuel' },
      { label: 'expenses.it.carInsurance', amount: 300, frequency: 'MONTHLY', icon: 'Car' },
      { label: 'expenses.it.tvLicense', amount: 90, frequency: 'ANNUAL', icon: 'Tv', tooltip: 'expenses.it.tvLicenseTooltip' },
      { label: 'expenses.it.imuTari', amount: Math.round(800 * coeff), frequency: 'ANNUAL', icon: 'Home', tooltip: 'expenses.it.imuTariTooltip' },
    ];
  }
};

export const PRESET_EXPENSES_CH = [
  { label: 'expenses.ch.rentPreset', amount: 1450, frequency: 'MONTHLY', icon: 'Home' },
  { label: 'expenses.ch.groceries', amount: 500, frequency: 'MONTHLY', icon: 'ShoppingBasket' },
  { label: 'expenses.ch.internet', amount: 60, frequency: 'MONTHLY', icon: 'Wifi' },
  { label: 'expenses.ch.tvLicense', amount: 335, frequency: 'ANNUAL', icon: 'Tv', tooltip: 'expenses.ch.tvLicenseTooltip' },
  { label: 'expenses.ch.simMobile', amount: 45, frequency: 'MONTHLY', icon: 'Smartphone', tooltip: 'expenses.ch.simMobileTooltip' },
  { label: 'expenses.ch.electricity', amount: 100, frequency: 'MONTHLY', icon: 'Zap' },
  { label: 'expenses.ch.transport', amount: 80, frequency: 'MONTHLY', icon: 'Bus' },
  { label: 'expenses.ch.carLease', amount: 400, frequency: 'MONTHLY', icon: 'Car' },
  { label: 'expenses.ch.wasteWater', amount: 50, frequency: 'MONTHLY', icon: 'Droplet' },
];

export const PRESET_EXPENSES_IT = [
  { label: 'expenses.it.rentPreset', amount: 750, frequency: 'MONTHLY', icon: 'Home' },
  { label: 'expenses.it.groceries', amount: 350, frequency: 'MONTHLY', icon: 'ShoppingBasket' },
  { label: 'expenses.it.internet', amount: 30, frequency: 'MONTHLY', icon: 'Wifi' },
  { label: 'expenses.it.simMobile', amount: 15, frequency: 'MONTHLY', icon: 'Smartphone', tooltip: 'expenses.it.simMobileTooltip' },
  { label: 'expenses.it.utilities', amount: 120, frequency: 'MONTHLY', icon: 'Zap' },
  { label: 'expenses.it.fuel', amount: 150, frequency: 'MONTHLY', icon: 'Fuel' },
  { label: 'expenses.it.carInsurance', amount: 300, frequency: 'MONTHLY', icon: 'Car' },
  { label: 'expenses.it.tvLicense', amount: 90, frequency: 'ANNUAL', icon: 'Tv', tooltip: 'expenses.it.tvLicenseTooltip' },
  { label: 'expenses.it.imuTari', amount: 800, frequency: 'ANNUAL', icon: 'Home', tooltip: 'expenses.it.imuTariTooltip' },
];

export const DEFAULT_INPUTS = {
  annualIncomeCHF: 100000,
  familyMembers: 3,
  children: 1,
  healthInsuranceCHF: 400,
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