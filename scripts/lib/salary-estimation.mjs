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
 */

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
const CATEGORY_TO_SECTOR = {
  // Core sectors
  tech: 'IT', finance: 'Finance', pharma: 'Pharma', engineering: 'Engineering',
  health: 'Healthcare', healthcare: 'Healthcare', admin: 'Logistics',
  sales: 'Retail', hr: 'Logistics', legal: 'Legal', logistics: 'Logistics',
  hospitality: 'Hospitality', construction: 'Construction', education: 'Education',
  retail: 'Retail', other: 'Logistics', marketing: 'Marketing',
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
};

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
 * Estimate salary range for a job based on category and title seniority.
 * Uses per-sector USTAT p25/p75 interquartile ratios for min/max spread,
 * with CCL minimum salary floors as hard lower bounds.
 *
 * The frontalieri discount (fronR) is applied by default because this platform
 * targets cross-border workers (Permit G). USTAT data shows frontalieri earn
 * on average 89% of the Ticino total, but the gap varies by sector:
 *   - IT: 86%, Finance: 99%, Healthcare: 101%, Construction: 97%
 * Set options.applyFrontialieriDiscount = false to get the total-population estimate.
 *
 * @param {object} job - Job object with category and title fields
 * @param {object} [options] - Optional settings
 * @param {boolean} [options.applyFrontialieriDiscount=true] - Apply frontalieri wage adjustment
 * @returns {{ minValue: number, maxValue: number, level: string, sectorName: string, frontialieriAdjusted: boolean }}
 */
export function estimateTicinoSalary(job, options = {}) {
  const { applyFrontialieriDiscount = true } = options;
  const cat = String(job?.category || 'other').toLowerCase();
  const sectorName = CATEGORY_TO_SECTOR[cat] || 'Logistics';
  const sector = TICINO_SECTOR_MEDIANS[sectorName] || TICINO_SECTOR_MEDIANS.Logistics;

  const title = String(job?.title || '')
    + ' ' + String(job?.titleByLocale?.it || '')
    + ' ' + String(job?.titleByLocale?.en || '');

  let level = 'mid';
  if (LEVEL_JUNIOR_RE.test(title)) level = 'junior';
  else if (LEVEL_SENIOR_RE.test(title)) level = 'senior';

  const rawMedian = sector[level];
  // Apply per-sector frontalieri discount from USTAT residency data
  const fronR = applyFrontialieriDiscount ? (sector.fronR || 0.89) : 1.0;
  const median = roundTo500(rawMedian * fronR);

  // Per-sector interquartile ratios from USTAT p25/p75 data
  const p25ratio = sector.p25r || 0.80;
  const p75ratio = sector.p75r || 1.25;
  const cclFloor = CCL_MINIMUM_FLOORS[sectorName] || CCL_MINIMUM_FLOORS._default;

  const minValue = Math.max(roundTo500(median * p25ratio), cclFloor);
  const maxValue = roundTo500(median * p75ratio);

  return { minValue, maxValue, level, sectorName, frontialieriAdjusted: applyFrontialieriDiscount && fronR < 1.0 };
}

export { TICINO_SECTOR_MEDIANS, CATEGORY_TO_SECTOR, CCL_MINIMUM_FLOORS, LEVEL_JUNIOR_RE, LEVEL_SENIOR_RE, roundTo500 };
