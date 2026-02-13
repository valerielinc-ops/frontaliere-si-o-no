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
      { label: 'Affitto (varia per nucleo)', amount: Math.round(1450 * coeff), icon: 'Home', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
      { label: 'Spesa Alimentare', amount: Math.round(500 * coeff), icon: 'ShoppingBasket', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
      { label: 'Internet & TV (Billag)', amount: 110, icon: 'Tv', tooltip: 'Include canone TV obbligatorio (Billag/Serafe). Tutte le spese Svizzera sono in CHF.' },
      { label: 'Cellulare Swisscom', amount: familyMembers === 1 ? 45 : Math.round(45 * Math.min(familyMembers, 3) * 0.7), icon: 'Smartphone', tooltip: 'Abbonamento cellulare svizzero. Tutte le spese Svizzera sono in CHF.' },
      { label: 'Elettricità & Riscaldamento', amount: Math.round(100 * coeff), icon: 'Zap', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
      { label: 'Trasporti/Abbonamento TPL', amount: 80, icon: 'Bus', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
      { label: 'Leasing/Rata Auto', amount: 400, icon: 'Car', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
      { label: 'Tassa Rifiuti/Acqua', amount: Math.round(50 * coeff), icon: 'Droplet', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
    ];
  } else {
    return [
      { label: 'Affitto/Mutuo (varia per nucleo)', amount: Math.round(750 * coeff), icon: 'Home' },
      { label: 'Spesa Alimentare', amount: Math.round(350 * coeff), icon: 'ShoppingBasket' },
      { label: 'Internet Casa Fibra', amount: 30, icon: 'Wifi' },
      { label: 'Cellulare (Tim/Vodafone)', amount: familyMembers === 1 ? 12 : Math.round(12 * Math.min(familyMembers, 3) * 0.8), icon: 'Smartphone', tooltip: 'Solo costo SIM (abbonamento voce/dati). Importi in EUR. Se hai cellulare a rate, aggiungilo come spesa separata.' },
      { label: 'Bollette Luce & Gas', amount: Math.round(120 * coeff), icon: 'Zap' },
      { label: 'Benzina/Autostrada', amount: 150, icon: 'Fuel' },
      { label: 'Rata Auto/Assicurazione', amount: 300, icon: 'Car' },
      { label: 'Canone RAI', amount: 90, icon: 'Tv', tooltip: 'Canone RAI annuale: 90€/anno (importo fisso, non mensile). Tutte le spese Italia sono in EUR.' },
      { label: 'IMU/TARI (se proprietari)', amount: Math.round(800 * coeff), icon: 'Home', tooltip: 'IMU: Non dovuta su prima casa (salvo immobili di lusso A/1, A/8, A/9). TARI: Molto variabile per comune e superficie (200-1000€/anno). Importi annuali in EUR, non mensili.' },
    ];
  }
};

export const PRESET_EXPENSES_CH = [
  { label: 'Affitto 2.5/3.5 Locali', amount: 1450, icon: 'Home', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
  { label: 'Spesa Alimentare', amount: 500, icon: 'ShoppingBasket', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
  { label: 'Internet & TV (Billag)', amount: 110, icon: 'Tv', tooltip: 'Include canone TV obbligatorio (Billag/Serafe). Tutte le spese Svizzera sono in CHF.' },
  { label: 'Cellulare Swisscom', amount: 45, icon: 'Smartphone', tooltip: 'Abbonamento cellulare svizzero. Tutte le spese Svizzera sono in CHF.' },
  { label: 'Elettricità & Riscaldamento', amount: 100, icon: 'Zap', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
  { label: 'Trasporti/Abbonamento TPL', amount: 80, icon: 'Bus', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
  { label: 'Leasing/Rata Auto', amount: 400, icon: 'Car', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
  { label: 'Tassa Rifiuti/Acqua', amount: 50, icon: 'Droplet', tooltip: 'Tutte le spese Svizzera sono in CHF (Franchi Svizzeri).' },
];

export const PRESET_EXPENSES_IT = [
  { label: 'Affitto/Mutuo', amount: 750, icon: 'Home' },
  { label: 'Spesa Alimentare', amount: 350, icon: 'ShoppingBasket' },
  { label: 'Internet Casa Fibra', amount: 30, icon: 'Wifi' },
  { label: 'Cellulare (Tim/Vodafone)', amount: 12, icon: 'Smartphone', tooltip: 'Solo costo SIM (abbonamento voce/dati). Importi in EUR. Se hai cellulare a rate, aggiungilo come spesa separata.' },
  { label: 'Bollette Luce & Gas', amount: 120, icon: 'Zap' },
  { label: 'Benzina/Autostrada', amount: 150, icon: 'Fuel' },
  { label: 'Rata Auto/Assicurazione', amount: 300, icon: 'Car' },
  { label: 'Canone RAI', amount: 90, icon: 'Tv', tooltip: 'Canone RAI annuale: 90€/anno (importo fisso, non mensile). Tutte le spese Italia sono in EUR.' },
  { label: 'IMU/TARI (se proprietari)', amount: 800, icon: 'Home', tooltip: 'IMU: Non dovuta su prima casa (salvo immobili di lusso A/1, A/8, A/9). TARI: Molto variabile per comune e superficie (200-1000€/anno). Importi annuali in EUR, non mensili.' },
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