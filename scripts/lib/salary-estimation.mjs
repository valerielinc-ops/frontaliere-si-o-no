/**
 * salary-estimation.mjs — Unified Ticino salary estimation
 *
 * Single source of truth for salary range estimation used by:
 *   - dedicated-crawler-common.mjs (inferSalaryRange)
 *   - re-enrich-jobs.mjs (estimateSalaryFromSectors)
 *
 * ── Data sources ────────────────────────────────────────────────────────────
 *
 * 1. USTAT Ticino — Rilevazione svizzera della struttura dei salari (RSS)
 *    cubi_RSS_02, anno 2024, settore privato, Canton Ticino
 *    https://www3.ti.ch/DFE/DR/USTAT/allegati/cubo/cubi_RSS_02_csv.zip
 *    895,862 rows, 55 NOGA sectors, p10/p25/p50/p75/p90, by gender/position/education/residency
 *
 * 2. CCL/GAV Ticino — Minimum salary floors from collective labor agreements
 *    - Edilizia (NOGA 41-43): CHF 56,076–72,984/year (OCST CCL 2023-2025)
 *    - Ristorazione (NOGA 55-56): CHF 47,658–67,925/year (L-GAV/CCNL 2024)
 *    - Cantonal minimum: CHF 20.00–20.50/hr ≈ CHF 41,600–42,640/year
 *    Sources: ti.ch/usml, gastrosuisse.ch, ocst.ch
 *
 * 3. BFS/UST Lohnstrukturerhebung (LSE) 2024 — Swiss national reference
 *    https://www.bfs.admin.ch/bfs/en/home/statistics/work-income.html
 *
 * ── Key statistical facts (Ticino 2024) ─────────────────────────────────────
 *
 *   Total employees (private sector): 153,987
 *   Overall median: CHF 5,393/month = CHF 64,716/year
 *   Ticino vs Swiss national: ~82%
 *   Frontalieri median: CHF 4,800/month (89% of Ticino total)
 *   Residents median: CHF 5,957/month (110% of Ticino total)
 *   Gender gap: 11.8% (M: CHF 5,614, F: CHF 4,952)
 *   Education premium: I(base)→II(sec) +20%, II→III(uni) +24%
 *   Salary growth 2008→2024: +9.4% nominal (+0.56%/year CAGR)
 *
 * ── Position-level mapping ──────────────────────────────────────────────────
 *   junior = "Senza funzione di quadro" (no management function)
 *   mid    = avg("Quadri inferiori" + "Responsabile esecuzione lavori")
 *   senior = "Quadri superiori e medi" (upper/middle management)
 *
 * ── Switzerland-wide generalization (June 2026) ─────────────────────────────
 *   estimateSwissSalary(job) scales this Ticino USTAT sector structure to the
 *   job's canton using the official BFS LSE Grossregion medians
 *   (data/swiss-canton-salary-index.json). Ticino factor = 1.0, so
 *   estimateTicinoSalary() — kept as a TI-pinned wrapper — stays byte-identical.
 */

import {
  getCantonSalaryFactor,
  isBorderCanton,
  getCantonSectorFloor,
  normalizeSalaryCantonCode,
} from './swiss-canton-salary.mjs';

// ── Ticino sector salary medians (annual gross CHF) ────────────────────────
// USTAT 2024 official data, p50 by NOGA 2008 sector × position level.
// Each sector includes actual p25/p50/p75 ratios and frontalieri discount factor.
const TICINO_SECTOR_MEDIANS = {
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
  Telecom:        { junior: 70000, mid:  78000, senior: 120000, p25r: 0.77, p75r: 1.31, fronR: 0.86, emp: 4773 },  // ≈ IT (NOGA 61 suppressed)
  Marketing:      { junior: 62000, mid:  75000, senior: 112000, p25r: 0.78, p75r: 1.38, fronR: 0.86, emp: 1098 },  // NOGA 58+73
  Consulting:     { junior: 60500, mid:  85500, senior: 106000, p25r: 0.81, p75r: 1.29, fronR: 0.88, emp: 6616 },  // NOGA 71+74
  MedicalDevices: { junior: 62000, mid:  91000, senior: 139500, p25r: 0.80, p75r: 1.33, fronR: 0.91, emp: 3796 },  // ≈ Pharma
  // ── New sectors added from USTAT 2024 ──
  Energy:         { junior: 82000, mid:  92000, senior: 130000, p25r: 0.82, p75r: 1.25, fronR: 0.90, emp: 901 },   // NOGA 35 (energia)
  FoodIndustry:   { junior: 50500, mid:  59500, senior:  71500, p25r: 0.87, p75r: 1.19, fronR: 0.96, emp: 2246 },  // NOGA 10 (alimentari)
  Manufacturing:  { junior: 47000, mid:  65000, senior: 114500, p25r: 0.89, p75r: 1.20, fronR: 0.96, emp: 4154 },  // NOGA 32 (manifatturiero vario)
  RealEstate:     { junior: 61000, mid:  75000, senior: 103000, p25r: 0.80, p75r: 1.33, fronR: 0.89, emp: 1922 },  // NOGA 68 (immobiliare)
  PersonalServices: { junior: 44500, mid: 47500, senior: 61500, p25r: 0.90, p75r: 1.21, fronR: 0.95, emp: 1539 }, // NOGA 96 (servizi personali)
};

// ── Category → Sector mapping ──────────────────────────────────────────────
// Keys are matched after normalizeCategoryKey() (accent-strip, lowercase,
// separator collapse — see below), so 'quality-assurance' and 'quality
// assurance' are the same lookup and only one needs to be listed.
const CATEGORY_TO_SECTOR = {
  // Core sectors
  tech: 'IT', finance: 'Finance', pharma: 'Pharma', engineering: 'Engineering',
  health: 'Healthcare', healthcare: 'Healthcare', admin: 'Logistics',
  sales: 'Retail', hr: 'Logistics', legal: 'Legal', logistics: 'Logistics',
  hospitality: 'Hospitality', construction: 'Construction', education: 'Education',
  retail: 'Retail', other: 'Logistics', altro: 'Logistics', marketing: 'Marketing',
  consulting: 'Consulting', insurance: 'Insurance', telecom: 'Telecom',
  // Extended mappings
  'dispositivi medici': 'MedicalDevices', 'medical devices': 'MedicalDevices',
  production: 'Engineering', it: 'IT', 'information technology': 'IT',
  'r-d': 'Engineering', 'research & development': 'Engineering',
  'quality-assurance': 'Pharma', 'quality assurance': 'Pharma',
  regulatory: 'Pharma', 'regulatory affairs': 'Pharma',
  'mkt-communication': 'Marketing', 'marketing & communication': 'Marketing',
  'general-services': 'Logistics', 'general services': 'Logistics',
  operations: 'Logistics', 'event-travel': 'Hospitality',
  'medical-affairs': 'Healthcare', 'medical affairs': 'Healthcare',
  // New sector mappings
  energy: 'Energy', 'energy & utilities': 'Energy', utilities: 'Energy',
  food: 'FoodIndustry', 'food & beverage': 'FoodIndustry', alimentare: 'FoodIndustry',
  manufacturing: 'Manufacturing', manifatturiero: 'Manufacturing',
  'real estate': 'RealEstate', immobiliare: 'RealEstate', 'real-estate': 'RealEstate',
  'personal services': 'PersonalServices', beauty: 'PersonalServices',
  wellness: 'PersonalServices', cleaning: 'PersonalServices',
  // ── Observed corpus labels (issue #6230, measured 2026-08-21) ──
  // Healthcare / Sanità / Gesundheitswesen
  'sanità / ospedali': 'Healthcare', sanità: 'Healthcare', 'sanità / assistenza': 'Healthcare',
  'sanità e sociale': 'Healthcare', gesundheitswesen: 'Healthcare', infermieristica: 'Healthcare',
  medicina: 'Healthcare', 'healthcare-nursing': 'Healthcare', 'healthcare-medical': 'Healthcare',
  'healthcare-therapy': 'Healthcare', 'healthcare-psychology': 'Healthcare', nursing: 'Healthcare',
  medical: 'Healthcare', psicologia: 'Healthcare', pediatria: 'Healthcare', radiologia: 'Healthcare',
  terapia: 'Healthcare', physiotherapy: 'Healthcare', 'salute / benessere': 'Healthcare',
  'life science & tecnologia medica': 'Healthcare', 'healthcare-medtech': 'MedicalDevices',
  // Engineering / Ingegneria / Tecnica
  tecnica: 'Engineering', ingegneria: 'Engineering', 'ingegneria & tecnica': 'Engineering',
  impiantistica: 'Engineering', 'strumentazione industriale / automazione': 'Engineering',
  ingenieurwesen: 'Engineering', meccanica: 'Engineering', elettrotecnica: 'Engineering',
  'robotica & automazione': 'Engineering', progettazione: 'Engineering',
  'progetti / tecnica edile': 'Engineering', 'tecnica agricola': 'Engineering',
  'vertrieb und technischer kundenservice': 'Engineering', drafting: 'Engineering', tecnico: 'Engineering',
  // Retail / Vendita / Commercio
  'vendita & commercio': 'Retail', commerciale: 'Retail', vendita: 'Retail', vendite: 'Retail',
  'agricoltura & commercio': 'Retail', ottica: 'Retail', 'commercio & servizi': 'Retail',
  'vendita al dettaglio': 'Retail', 'verkauf und kundenberatung': 'Retail',
  'vendite & commerciale': 'Retail', 'it / salesforce': 'IT',
  'sales channels & retail excellence/retail': 'Retail',
  // Hospitality / Ospitalità / Ristorazione
  ospitalità: 'Hospitality', 'turismo & ospitalità': 'Hospitality', cucina: 'Hospitality',
  ristorazione: 'Hospitality', 'ospitalità / ristorazione': 'Hospitality',
  'hospitality-food-beverage': 'Hospitality', housekeeping: 'Hospitality', turismo: 'Hospitality',
  tourism: 'Hospitality', ricevimento: 'Hospitality', 'cucina / gastronomia': 'Hospitality',
  'hospitality-housekeeping': 'Hospitality', gastronomia: 'Hospitality', 'hospitality-spa': 'Hospitality',
  'hospitality-front-office': 'Hospitality', 'hospitality-events': 'Hospitality',
  // Logistics / Logistica / Trasporti
  logistica: 'Logistics', 'servizi-postali': 'Logistics', 'logistica & trasporti': 'Logistics',
  trasporti: 'Logistics', 'autisti / chauffeur': 'Logistics', 'autisti / conducenti': 'Logistics',
  'trasporti / autisti': 'Logistics', 'lager und logistik': 'Logistics', transport: 'Logistics',
  'logistica & magazzino': 'Logistics', 'guida / conduzione': 'Logistics',
  // Legal / Legale / Giuridico
  legale: 'Legal', 'qualità / compliance': 'Legal', giuridico: 'Legal', 'compliance & risk': 'Legal',
  // Finance / Finanza
  finanza: 'Finance', tax: 'Finance', audit: 'Finance', banca: 'Finance', 'finanza / banca': 'Finance',
  'consulenza finanziaria': 'Finance', 'wealth-management': 'Finance', anlageberatung: 'Finance',
  'finanzen controlling und accounting': 'Finance',
  'corporate and staff functions/finance & control': 'Finance', 'büro-finanzen und revision': 'Finance',
  // Insurance / Assicurazioni
  assicurazioni: 'Insurance',
  // Education / Formazione / Istruzione
  formazione: 'Education', 'istruzione / docenza': 'Education', istruzione: 'Education',
  'istruzione / sostegno pedagogico': 'Education', 'istruzione / scuola speciale': 'Education',
  'educazione & cultura': 'Education', 'sociale / educazione': 'Education',
  'istruzione / direzione scolastica': 'Education', 'istruzione / assistenza in classe': 'Education',
  'formazione / ricerca': 'Education',
  // Marketing
  'marketing / comunicazione': 'Marketing', 'marketing und kommunikation': 'Marketing',
  // Manufacturing / Produzione
  produzione: 'Manufacturing', 'produktion und fertigung': 'Manufacturing', metallo: 'Manufacturing',
  'produzione media': 'Marketing',
  'product development, manufacturing, end-to end supply chain/manufacturing': 'Manufacturing',
  // Construction / Edilizia
  edilizia: 'Construction', elettricità: 'Construction', costruzioni: 'Construction',
  cantiere: 'Construction', 'edilizia & costruzioni': 'Construction',
  // IT / Informatica
  technology: 'IT', 'it / sviluppo software': 'IT', 'informatik und digital services': 'IT',
  'it und software': 'IT', informatica: 'IT', devops: 'IT', 'it / infrastruttura': 'IT',
  'it / sicurezza': 'IT', 'it / project management': 'IT', 'it & digital transformation': 'IT',
  // Energy / Ambiente
  'ambiente / energia': 'Energy', energia: 'Energy',
  // FoodIndustry / Agricoltura
  'agricoltura & mangimi': 'FoodIndustry', 'industria alimentare': 'FoodIndustry',
  // PersonalServices
  'pulizie di manutenzione': 'PersonalServices', 'facility management': 'PersonalServices',
  'pulizie specializzate': 'PersonalServices', giardinaggio: 'PersonalServices',
  // Consulting
  consulenza: 'Consulting',
  // Pharma
  science: 'Pharma', chemistry: 'Pharma', biotech: 'Pharma', 'chimica & analisi': 'Pharma',
  chimica: 'Pharma', laboratorio: 'Pharma', scienza: 'Pharma',
};

/**
 * Normalize a category label for CATEGORY_TO_SECTOR lookup: strip accents,
 * lowercase, collapse separators (/, &, -, _, comma, dot, parens) to a
 * single space, trim. Applied to both the map keys (once, at module load)
 * and the job's category value, so 'Sanità / Ospedali', 'sanita-ospedali'
 * and 'SANITÀ  OSPEDALI' all resolve to the same lookup key.
 */
function normalizeCategoryKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[/&_,.()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_CATEGORY_TO_SECTOR = Object.fromEntries(
  Object.entries(CATEGORY_TO_SECTOR).map(([key, sector]) => [normalizeCategoryKey(key), sector])
);

// ── CCL/GAV minimum salary floors (annual gross CHF) ───────────────────────
// Hard floors from collective labor agreements — estimates never go below these.
// Sources: OCST (edilizia), L-GAV (ristorazione), Canton TI minimum wage.
const CCL_MINIMUM_FLOORS = {
  Construction:     56076,  // Lavoratore senza conoscenze professionali (OCST CCL 2023-2025)
  Hospitality:      47658,  // Employee without qualification, Cat. Ia (L-GAV/CCNL 2024)
  Retail:           41600,  // Cantonal minimum: CHF 20.00/hr × 2080 hours
  FoodIndustry:     41600,  // Cantonal minimum
  PersonalServices: 41600,  // Cantonal minimum
  Manufacturing:    42640,  // Cantonal minimum: CHF 20.50/hr × 2080 hours
  Engineering:      42640,  // CHF 20.50/hr
  _default:         41600,  // Cantonal minimum: CHF 20.00/hr × 2080 hours
};

// ── Level detection regexes ────────────────────────────────────────────────
const LEVEL_JUNIOR_RE = /\b(junior|intern|stage|trainee|apprentice|apprendist\w*|stagiaire|praktikant|lehrstelle|tirocinio|entry[- ]?level|jr\.?)\b/i;
const LEVEL_SENIOR_RE = /\b(senior|lead|head|director|manager|principal|vp|vice[- ]?president|chief|c[eft]o|responsabile|direttore|leiter|verantwortlich|sr\.?)\b/i;

function roundTo500(value) {
  return Math.max(500, Math.round(Number(value || 0) / 500) * 500);
}

/**
 * Estimate a salary range for a job, scaled to the job's Swiss canton.
 *
 * The Ticino USTAT sector structure (per-sector p25/p75 interquartile spread,
 * seniority levels, frontalieri ratio) is the shape; the canton's official BFS
 * LSE Grossregion median sets the level via
 *   factor = grossregionMedian(canton) / ticinoMedian
 * (data/swiss-canton-salary-index.json). Ticino factor = 1.0.
 *
 * The frontalieri discount (fronR) is applied only for BORDER cantons, where
 * Permit G commuters actually work; USTAT shows frontalieri earn on average
 * ~89% of the Ticino total, varying by sector (IT 86%, Finance 99%,
 * Healthcare 101%, Construction 97%). Interior cantons (no cross-border
 * workforce) use the full resident median. Lower bounds come from the Ticino
 * CCL floor table for TI, or national GAV floors + the cantonal statutory
 * minimum wage for other cantons.
 *
 * @param {object} job - Job with category, title and (optionally) canton fields
 * @param {object} [options] - Optional settings
 * @param {boolean} [options.applyFrontialieriDiscount=true] - Apply the border-canton frontalieri wage adjustment
 * @returns {{ minValue: number, maxValue: number, level: string, sectorName: string, frontialieriAdjusted: boolean, canton: string, cantonFactor: number }}
 */
export function estimateSwissSalary(job, options = {}) {
  const { applyFrontialieriDiscount = true } = options;
  const canton = normalizeSalaryCantonCode(job?.canton);
  const factor = getCantonSalaryFactor(canton);
  const border = isBorderCanton(canton);

  const cat = normalizeCategoryKey(job?.category || 'other');
  const sectorName = NORMALIZED_CATEGORY_TO_SECTOR[cat] || 'Logistics';
  const sector = TICINO_SECTOR_MEDIANS[sectorName] || TICINO_SECTOR_MEDIANS.Logistics;

  const title = String(job?.title || '')
    + ' ' + String(job?.titleByLocale?.it || '')
    + ' ' + String(job?.titleByLocale?.en || '');

  let level = 'mid';
  if (LEVEL_JUNIOR_RE.test(title)) level = 'junior';
  else if (LEVEL_SENIOR_RE.test(title)) level = 'senior';

  // Scale the Ticino sector median to the canton wage level.
  const rawMedian = sector[level] * factor;
  // Frontalieri discount only where cross-border workers actually commute.
  const applyDiscount = applyFrontialieriDiscount && border;
  const fronR = applyDiscount ? (sector.fronR || 0.89) : 1.0;
  const median = roundTo500(rawMedian * fronR);

  // Per-sector interquartile ratios from USTAT p25/p75 data
  const p25ratio = sector.p25r || 0.80;
  const p75ratio = sector.p75r || 1.25;
  // Ticino keeps its richer CCL floor table; other cantons use national GAV
  // floors + their statutory minimum wage (or the universal sanity floor).
  const floor = canton === 'TI'
    ? (CCL_MINIMUM_FLOORS[sectorName] || CCL_MINIMUM_FLOORS._default)
    : getCantonSectorFloor(sectorName, canton);

  const minValue = Math.max(roundTo500(median * p25ratio), floor);
  const maxValue = roundTo500(median * p75ratio);

  return {
    minValue,
    maxValue,
    level,
    sectorName,
    frontialieriAdjusted: applyDiscount && fronR < 1.0,
    canton,
    cantonFactor: factor,
  };
}

/**
 * Ticino-pinned salary estimate. Backward-compatible wrapper that ignores
 * job.canton and always uses the Ticino model (factor 1.0) — output is
 * byte-identical to the pre-June-2026 estimator. Prefer estimateSwissSalary()
 * for canton-aware estimates.
 *
 * @param {object} job - Job object with category and title fields
 * @param {object} [options] - Optional settings
 * @param {boolean} [options.applyFrontialieriDiscount=true] - Apply frontalieri wage adjustment
 * @returns {{ minValue: number, maxValue: number, level: string, sectorName: string, frontialieriAdjusted: boolean }}
 */
export function estimateTicinoSalary(job, options = {}) {
  const { minValue, maxValue, level, sectorName, frontialieriAdjusted } =
    estimateSwissSalary({ ...job, canton: 'TI' }, options);
  return { minValue, maxValue, level, sectorName, frontialieriAdjusted };
}

export {
  TICINO_SECTOR_MEDIANS,
  CATEGORY_TO_SECTOR,
  NORMALIZED_CATEGORY_TO_SECTOR,
  normalizeCategoryKey,
  CCL_MINIMUM_FLOORS,
  LEVEL_JUNIOR_RE,
  LEVEL_SENIOR_RE,
  roundTo500,
};
