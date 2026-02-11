export const DEFAULT_EXCHANGE_RATE = 1.06; // Fallback
export const FRANCHIGIA_NUOVI_FRONTALIERI = 10000;
export const SWISS_CHILD_ALLOWANCE_ANNUAL = 3000; // ~250 CHF/month avg
export const ITALY_CHILD_ALLOWANCE_ANNUAL_MIN = 684; // ~57 EUR/month min for high income

export const LINKS = {
  TI_TAX: "https://www4.ti.ch/dfe/dc/imposte/persone-fisiche/calcolatore-dimposta",
  IT_IRPEF: "https://www.agenziaentrate.gov.it/portale/imposta-sul-reddito-delle-persone-fisiche-irpef-aliquote-e-scaglioni",
};

export const DEFAULT_INPUTS = {
  annualIncomeCHF: 100000,
  familyMembers: 3,
  children: 1,
  healthInsuranceCHF: 1200, // Monthly (3 members * 400 CHF)
  frontierWorkerType: 'NEW' as const,
  distanceZone: 'WITHIN_20KM' as const,
  customExchangeRate: DEFAULT_EXCHANGE_RATE,
  monthsBasis: 12,
  age: 35,
  maritalStatus: 'SINGLE' as const,
  sex: 'M' as const,
  spouseWorks: false,
};

export const COLORS = {
  switzerland: '#0ea5e9', // Sky 500
  italy: '#ef4444', // Red 500
  savings: '#10b981', // Emerald 500
};