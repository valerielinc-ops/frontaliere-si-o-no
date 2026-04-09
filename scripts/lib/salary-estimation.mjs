/**
 * salary-estimation.mjs — Unified Ticino salary estimation
 *
 * Single source of truth for salary range estimation used by:
 *   - dedicated-crawler-common.mjs (inferSalaryRange)
 *   - re-enrich-jobs.mjs (estimateSalaryFromSectors)
 *
 * Data source: USTAT Ticino — Rilevazione svizzera della struttura dei salari
 *   (cubi_RSS_02), anno 2024, settore privato, Canton Ticino.
 *   https://www3.ti.ch/DFE/DR/USTAT/allegati/cubo/cubi_RSS_02_csv.zip
 *
 * Position-level mapping:
 *   junior = "Senza funzione di quadro" (no management function)
 *   mid    = avg("Quadri inferiori" + "Responsabile esecuzione lavori")
 *   senior = "Quadri superiori e medi" (upper/middle management)
 *
 * Key statistical facts (Ticino 2024):
 *   Overall median: CHF 5,393/month = CHF 64,716/year
 *   Ticino vs Swiss national: ~82% (not 90% as previously assumed)
 *   Frontalieri earn ~89% of Ticino total (CHF 4,800/month median)
 *
 * Min/max range: ×0.80 / ×1.25 based on USTAT p25/p75 interquartile ratios.
 *   Average p25/p50 = 0.82, average p75/p50 = 1.32 (capped to ×1.25).
 */

// ── Ticino sector salary medians (annual gross CHF) ────────────────────────
// USTAT 2024 official data, p50 by NOGA 2008 sector × position level.
// NOGA codes mapped to project categories (see comments per sector).
const TICINO_SECTOR_MEDIANS = {
  IT:             { junior: 70000, mid:  78000, senior: 120000 }, // NOGA 62 (programmazione) + 63 (servizi informativi)
  Finance:        { junior: 77000, mid: 110500, senior: 184000 }, // NOGA 64 (servizi finanziari) + 66 (attività ausiliarie)
  Pharma:         { junior: 62000, mid:  91000, senior: 139500 }, // NOGA 20 (chimica) + 21 (farmaceutica) + 72 (R&S)
  Engineering:    { junior: 52500, mid:  76000, senior: 104000 }, // NOGA 25+27+28 (metallo, elettronica, macchinari)
  Healthcare:     { junior: 72500, mid:  81000, senior: 109500 }, // NOGA 86 (sanitario) + 88 (assistenza sociale)
  Retail:         { junior: 59500, mid:  75500, senior: 106000 }, // NOGA 45+46+47 (commercio auto/ingrosso/dettaglio)
  Hospitality:    { junior: 49000, mid:  61500, senior:  82500 }, // NOGA 55 (alloggio) + 56 (ristorazione)
  Construction:   { junior: 59000, mid:  69500, senior:  93500 }, // NOGA 41+42+43 (edilizia, ing. civile, lavori spec.)
  Education:      { junior: 53000, mid:  62500, senior:  94000 }, // NOGA 85 (istruzione)
  Logistics:      { junior: 55500, mid:  66000, senior:  91000 }, // NOGA 49 (trasporti) + 52 (magazzinaggio) + 82 (supporto)
  Legal:          { junior: 64500, mid:  80500, senior: 125000 }, // NOGA 69 (attività legali e contabilità)
  Insurance:      { junior: 61000, mid:  75000, senior: 103000 }, // NOGA 68 (immobiliare; NOGA 65 assicurazioni soppressa)
  Telecom:        { junior: 70000, mid:  78000, senior: 120000 }, // Mapped to IT (NOGA 61 telecom soppressa per Ticino)
  Marketing:      { junior: 62000, mid:  75000, senior: 112000 }, // NOGA 58 (editoria) + 73 (pubblicità/ricerche mercato)
  Consulting:     { junior: 60500, mid:  85500, senior: 106000 }, // NOGA 71 (architettura/ingegneria) + 74 (altre profess.)
  MedicalDevices: { junior: 62000, mid:  91000, senior: 139500 }, // Same as Pharma (NOGA 20+21+72)
};

// ── Category → Sector mapping ──────────────────────────────────────────────
const CATEGORY_TO_SECTOR = {
  tech: 'IT', finance: 'Finance', pharma: 'Pharma', engineering: 'Engineering',
  health: 'Healthcare', healthcare: 'Healthcare', admin: 'Logistics',
  sales: 'Retail', hr: 'Logistics', legal: 'Legal', logistics: 'Logistics',
  hospitality: 'Hospitality', construction: 'Construction', education: 'Education',
  retail: 'Retail', other: 'Logistics', marketing: 'Marketing',
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
};

// ── Level detection regexes ────────────────────────────────────────────────
const LEVEL_JUNIOR_RE = /\b(junior|intern|stage|trainee|apprentice|apprendist\w*|stagiaire|praktikant|lehrstelle|tirocinio|entry[- ]?level|jr\.?)\b/i;
const LEVEL_SENIOR_RE = /\b(senior|lead|head|director|manager|principal|vp|vice[- ]?president|chief|c[eft]o|responsabile|direttore|leiter|verantwortlich|sr\.?)\b/i;

function roundTo500(value) {
  return Math.max(500, Math.round(Number(value || 0) / 500) * 500);
}

/**
 * Estimate salary range for a job based on category and title seniority.
 *
 * @param {object} job - Job object with category and title fields
 * @returns {{ minValue: number, maxValue: number, level: string, sectorName: string }}
 */
export function estimateTicinoSalary(job) {
  const cat = String(job?.category || 'other').toLowerCase();
  const sectorName = CATEGORY_TO_SECTOR[cat] || 'Logistics';
  const sector = TICINO_SECTOR_MEDIANS[sectorName] || TICINO_SECTOR_MEDIANS.Logistics;

  const title = String(job?.title || '')
    + ' ' + String(job?.titleByLocale?.it || '')
    + ' ' + String(job?.titleByLocale?.en || '');

  let level = 'mid';
  if (LEVEL_JUNIOR_RE.test(title)) level = 'junior';
  else if (LEVEL_SENIOR_RE.test(title)) level = 'senior';

  const median = sector[level];
  // Min/max from USTAT p25/p75 interquartile ratios (avg p25/p50=0.82, p75/p50=1.32)
  const minValue = roundTo500(median * 0.80);
  const maxValue = roundTo500(median * 1.25);

  return { minValue, maxValue, level, sectorName };
}

export { TICINO_SECTOR_MEDIANS, CATEGORY_TO_SECTOR, LEVEL_JUNIOR_RE, LEVEL_SENIOR_RE, roundTo500 };
