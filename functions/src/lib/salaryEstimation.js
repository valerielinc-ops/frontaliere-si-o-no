/**
 * salaryEstimation.js — Native Swiss Salary Estimation Engine for Cloud Functions
 *
 * Grounded in:
 * 1. USTAT Ticino RSS 2024 (Rilevazione svizzera della struttura dei salari):
 *    895,862 records, 55 NOGA sectors, p10/p25/p50/p75/p90, junior/mid/senior,
 *    and empirical frontalieri wage discount ratios (fronR: IT 86%, Finance 99%, etc.).
 * 2. CCL / GAV minimum floors: OCST (edilizia), L-GAV (ristorazione), and cantonal statutory minimums.
 * 3. Official BFS Grossregion medians (data/swiss-canton-salary-index.json) scaling across all 26 cantons.
 */

import SWISS_CANTON_SALARY_INDEX from '../data/salary-benchmarks/swiss-canton-salary-index.json' with { type: 'json' };

const TI_MEDIAN = Number(SWISS_CANTON_SALARY_INDEX.ticinoMedianMonthly) || 5708;
const CANTON_TO_REGION = SWISS_CANTON_SALARY_INDEX.cantonToGrossregion || {};
const REGION_MEDIAN = SWISS_CANTON_SALARY_INDEX.grossregionMedianMonthly || {};
const BORDER = new Set(SWISS_CANTON_SALARY_INDEX.borderCantons || []);
const STATUTORY_FLOOR = SWISS_CANTON_SALARY_INDEX.statutoryMinWageAnnual || {};
const UNIVERSAL_FLOOR = Number(SWISS_CANTON_SALARY_INDEX.universalFloorAnnual) || 41600;
const SECTOR_GAV_FLOOR = SWISS_CANTON_SALARY_INDEX.nationalSectorGavFloorAnnual || {};

export const CANTON_NAMES = Object.freeze({
  AG: 'Canton Argovia',
  AI: 'Canton Appenzello Interno',
  AR: 'Canton Appenzello Esterno',
  BE: 'Canton Berna',
  BL: 'Canton Basilea Campagna',
  BS: 'Canton Basilea Città',
  FR: 'Canton Friburgo',
  GE: 'Canton Ginevra',
  GL: 'Canton Glarona',
  GR: 'Canton Grigioni',
  JU: 'Canton Giura',
  LU: 'Canton Lucerna',
  NE: 'Canton Neuchâtel',
  NW: 'Canton Nidvaldo',
  OW: 'Canton Obvaldo',
  SG: 'Canton San Gallo',
  SH: 'Canton Sciaffusa',
  SO: 'Canton Soletta',
  SZ: 'Canton Svitto',
  TG: 'Canton Turgovia',
  TI: 'Canton Ticino',
  UR: 'Canton Uri',
  VD: 'Canton Vaud',
  VS: 'Canton Vallese',
  ZG: 'Canton Zugo',
  ZH: 'Canton Zurigo',
});

export const TICINO_SECTOR_MEDIANS = {
  //                              junior    mid    senior    p25ratio p75ratio fronRatio  employees NOGA refs
  IT:             { junior: 70000, mid:  78000, senior: 120000, p25r: 0.77, p75r: 1.31, fronR: 0.86, emp: 4773 }, // NOGA 62+63
  Finance:        { junior: 77000, mid: 110500, senior: 184000, p25r: 0.78, p75r: 1.37, fronR: 0.99, emp: 7446 }, // NOGA 64+66
  Pharma:         { junior: 62000, mid:  91000, senior: 139500, p25r: 0.80, p75r: 1.33, fronR: 0.91, emp: 3796 }, // NOGA 20+21+72
  Engineering:    { junior: 52500, mid:  76000, senior: 104000, p25r: 0.83, p75r: 1.26, fronR: 0.92, emp: 8820 }, // NOGA 25+26+27+28
  Healthcare:     { junior: 72500, mid:  81000, senior: 109500, p25r: 0.86, p75r: 1.20, fronR: 1.01, emp: 14762 }, // NOGA 86+88
  Retail:         { junior: 59500, mid:  75500, senior: 106000, p25r: 0.84, p75r: 1.29, fronR: 0.93, emp: 23782 }, // NOGA 45+46+47
  Hospitality:    { junior: 49000, mid:  61500, senior:  82500, p25r: 0.90, p75r: 1.13, fronR: 0.97, emp: 12411 }, // NOGA 55+56
  Construction:   { junior: 59000, mid:  69500, senior:  93500, p25r: 0.90, p75r: 1.14, fronR: 0.97, emp: 14327 }, // NOGA 41+42+43
  Education:      { junior: 53000, mid:  62500, senior:  94000, p25r: 0.77, p75r: 1.42, fronR: 0.87, emp: 2310 },  // NOGA 85
  Logistics:      { junior: 55500, mid:  66000, senior:  91000, p25r: 0.85, p75r: 1.29, fronR: 0.88, emp: 5640 },  // NOGA 49+52+82
  Legal:          { junior: 64500, mid:  80500, senior: 125000, p25r: 0.80, p75r: 1.37, fronR: 0.87, emp: 4339 },  // NOGA 69
  Insurance:      { junior: 61000, mid:  75000, senior: 103000, p25r: 0.80, p75r: 1.33, fronR: 0.89, emp: 1922 },  // NOGA 68
  Telecom:        { junior: 70000, mid:  78000, senior: 120000, p25r: 0.77, p75r: 1.31, fronR: 0.86, emp: 4773 },  // ≈ IT
  Marketing:      { junior: 62000, mid:  75000, senior: 112000, p25r: 0.78, p75r: 1.38, fronR: 0.86, emp: 1098 },  // NOGA 58+73
  Consulting:     { junior: 60500, mid:  85500, senior: 106000, p25r: 0.81, p75r: 1.29, fronR: 0.88, emp: 6616 },  // NOGA 71+74
  MedicalDevices: { junior: 62000, mid:  91000, senior: 139500, p25r: 0.80, p75r: 1.33, fronR: 0.91, emp: 3796 },  // ≈ Pharma
  Energy:         { junior: 82000, mid:  92000, senior: 130000, p25r: 0.82, p75r: 1.25, fronR: 0.90, emp: 901 },   // NOGA 35
  FoodIndustry:   { junior: 50500, mid:  59500, senior:  71500, p25r: 0.87, p75r: 1.19, fronR: 0.96, emp: 2246 },  // NOGA 10
  Manufacturing:  { junior: 47000, mid:  65000, senior: 114500, p25r: 0.89, p75r: 1.20, fronR: 0.96, emp: 4154 },  // NOGA 32
  RealEstate:     { junior: 61000, mid:  75000, senior: 103000, p25r: 0.80, p75r: 1.33, fronR: 0.89, emp: 1922 },  // NOGA 68
  PersonalServices: { junior: 44500, mid: 47500, senior: 61500, p25r: 0.90, p75r: 1.21, fronR: 0.95, emp: 1539 }, // NOGA 96
};

export const CATEGORY_TO_SECTOR = {
  // Role key aliases
  software_engineer: 'IT',
  devops_cloud_engineer: 'IT',
  financial_analyst: 'Finance',
  pharma_specialist: 'Pharma',
  mechanical_engineer: 'Engineering',
  nurse_healthcare: 'Healthcare',
  general_office: 'Logistics',

  // Core sectors
  tech: 'IT', finance: 'Finance', pharma: 'Pharma', engineering: 'Engineering',
  health: 'Healthcare', healthcare: 'Healthcare', admin: 'Logistics',
  sales: 'Retail', hr: 'Logistics', legal: 'Legal', logistics: 'Logistics',
  hospitality: 'Hospitality', construction: 'Construction', education: 'Education',
  retail: 'Retail', other: 'Logistics', altro: 'Logistics', marketing: 'Marketing',
  consulting: 'Consulting', insurance: 'Insurance', telecom: 'Telecom',
  'dispositivi medici': 'MedicalDevices', 'medical devices': 'MedicalDevices',
  production: 'Engineering', it: 'IT', 'information technology': 'IT',
  'r-d': 'Engineering', 'research & development': 'Engineering',
  'quality-assurance': 'Pharma', 'quality assurance': 'Pharma',
  regulatory: 'Pharma', 'regulatory affairs': 'Pharma',
  'mkt-communication': 'Marketing', 'marketing & communication': 'Marketing',
  'general-services': 'Logistics', 'general services': 'Logistics',
  operations: 'Logistics', 'event-travel': 'Hospitality',
  'medical-affairs': 'Healthcare', 'medical affairs': 'Healthcare',
  energy: 'Energy', 'energy & utilities': 'Energy', utilities: 'Energy',
  food: 'FoodIndustry', 'food & beverage': 'FoodIndustry', alimentare: 'FoodIndustry',
  manufacturing: 'Manufacturing', manifatturiero: 'Manufacturing',
  'real estate': 'RealEstate', immobiliare: 'RealEstate', 'real-estate': 'RealEstate',
  'personal services': 'PersonalServices', beauty: 'PersonalServices',
  wellness: 'PersonalServices', cleaning: 'PersonalServices',
  'sanità / ospedali': 'Healthcare', sanità: 'Healthcare', 'sanità / assistenza': 'Healthcare',
  'sanità e sociale': 'Healthcare', gesundheitswesen: 'Healthcare', infermieristica: 'Healthcare',
  medicina: 'Healthcare', 'healthcare-nursing': 'Healthcare', 'healthcare-medical': 'Healthcare',
  'healthcare-therapy': 'Healthcare', nursing: 'Healthcare', medical: 'Healthcare',
  tecnica: 'Engineering', ingegneria: 'Engineering', 'ingegneria & tecnica': 'Engineering',
  meccanica: 'Engineering', elettrotecnica: 'Engineering', 'robotica & automazione': 'Engineering',
  progettazione: 'Engineering', software: 'IT', developer: 'IT', devops: 'IT',
  vendita: 'Retail', commerciale: 'Retail', 'vendita & commercio': 'Retail',
  ristorazione: 'Hospitality', cucina: 'Hospitality', ospitalità: 'Hospitality', turismo: 'Hospitality',
  logistica: 'Logistics', trasporti: 'Logistics', 'logistica & trasporti': 'Logistics',
  legale: 'Legal', giuridico: 'Legal', 'compliance & risk': 'Legal',
  finanza: 'Finance', banca: 'Finance', 'finanza / banca': 'Finance', contabilità: 'Finance',
  assicurazioni: 'Insurance', formazione: 'Education', istruzione: 'Education',
  edilizia: 'Construction', costruzioni: 'Construction', cantiere: 'Construction',
  chimica: 'Pharma', biotech: 'Pharma', scienza: 'Pharma',
};

export function normalizeCategoryKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[/&_,.()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const NORMALIZED_CATEGORY_TO_SECTOR = Object.fromEntries(
  Object.entries(CATEGORY_TO_SECTOR).map(([key, sector]) => [normalizeCategoryKey(key), sector])
);

export const CCL_MINIMUM_FLOORS = {
  Construction:     56076,
  Hospitality:      47658,
  Retail:           41600,
  FoodIndustry:     41600,
  PersonalServices: 41600,
  Manufacturing:    42640,
  Engineering:      42640,
  _default:         41600,
};

const LEVEL_JUNIOR_RE = /\b(junior|intern|stage|trainee|apprentice|apprendist\w*|stagiaire|praktikant|lehrstelle|tirocinio|entry[- ]?level|jr\.?)\b/i;
const LEVEL_LEAD_RE = /\b(lead|principal|head|director|manager|responsabile)\b/i;
const LEVEL_SENIOR_RE = /\b(senior|sr\.?|esperto|guida|director|manager|principal|vp|vice[- ]?president|chief|c[eft]o|responsabile|direttore|leiter|verantwortlich)\b/i;

export function roundTo500(value) {
  return Math.max(500, Math.round(Number(value || 0) / 500) * 500);
}

export function normalizeSalaryCantonCode(code) {
  const c = String(code || '').toUpperCase().trim();
  return /^[A-Z]{2}$/.test(c) && CANTON_TO_REGION[c] ? c : 'TI';
}

export function getCantonSalaryFactor(code) {
  const c = normalizeSalaryCantonCode(code);
  const region = CANTON_TO_REGION[c];
  const median = Number(REGION_MEDIAN[region]);
  if (!Number.isFinite(median) || !(TI_MEDIAN > 0)) return 1;
  return median / TI_MEDIAN;
}

export function isBorderCanton(code) {
  return BORDER.has(normalizeSalaryCantonCode(code));
}

export function getCantonSectorFloor(sectorName, code) {
  const c = normalizeSalaryCantonCode(code);
  const gav = Number(SECTOR_GAV_FLOOR[sectorName]) || 0;
  const statutory = Number(STATUTORY_FLOOR[c]) || UNIVERSAL_FLOOR;
  return Math.max(gav, statutory);
}

export function inferSeniorityTier(title, years = 0) {
  const t = String(title || '');
  if (LEVEL_LEAD_RE.test(t) || years >= 10) return 'lead';
  if (LEVEL_SENIOR_RE.test(t) || years >= 5) return 'senior';
  if (LEVEL_JUNIOR_RE.test(t) || (years > 0 && years < 3)) return 'junior';
  return 'mid';
}

/**
 * Estimate a Swiss salary range using the official USTAT + BFS model.
 *
 * @param {object} job - Job object with category, title, and canton fields
 * @param {object} [options]
 * @param {boolean} [options.applyFrontialieriDiscount=false] - Apply border canton frontalieri adjustment (default false for candidate negotiations)
 * @returns {{ minValue: number, maxValue: number, median: number, level: string, sectorName: string, frontialieriAdjusted: boolean, canton: string, cantonFactor: number }}
 */
export function estimateSwissSalary(job, options = {}) {
  const { applyFrontialieriDiscount = false } = options;
  const canton = normalizeSalaryCantonCode(job?.canton);
  const factor = getCantonSalaryFactor(canton);
  const border = isBorderCanton(canton);

  const rawCat = job?.category || job?.sector || job?.industry || 'other';
  const cat = normalizeCategoryKey(rawCat);
  const sectorName = NORMALIZED_CATEGORY_TO_SECTOR[cat] || 'Logistics';
  const sector = TICINO_SECTOR_MEDIANS[sectorName] || TICINO_SECTOR_MEDIANS.Logistics;

  const title = String(job?.title || '') + ' ' + String(job?.roleTitle || '');
  let tier = job?.seniority || inferSeniorityTier(title, job?.yearsExperience || 0);
  let level = tier === 'lead' ? 'senior' : tier;

  let rawMedian = sector[level] * factor;
  if (tier === 'lead') {
    rawMedian *= 1.10; // 10% premium for lead/principal roles over senior baseline
  }

  const applyDiscount = applyFrontialieriDiscount && border;
  const fronR = applyDiscount ? (sector.fronR || 0.89) : 1.0;
  const median = roundTo500(rawMedian * fronR);

  const p25ratio = sector.p25r || 0.80;
  const p75ratio = sector.p75r || 1.25;

  const floor = canton === 'TI'
    ? (CCL_MINIMUM_FLOORS[sectorName] || CCL_MINIMUM_FLOORS._default)
    : getCantonSectorFloor(sectorName, canton);

  const minValue = Math.max(roundTo500(median * p25ratio), floor);
  const maxValue = roundTo500(median * p75ratio);

  return {
    minValue,
    maxValue,
    median,
    level: tier,
    sectorName,
    frontialieriAdjusted: applyDiscount && fronR < 1.0,
    canton,
    cantonFactor: factor,
  };
}
