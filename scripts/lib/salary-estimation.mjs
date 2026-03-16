/**
 * salary-estimation.mjs — Unified Ticino salary estimation
 *
 * Single source of truth for salary range estimation used by:
 *   - dedicated-crawler-common.mjs (inferSalaryRange)
 *   - re-enrich-jobs.mjs (estimateSalaryFromSectors)
 *
 * Data source: salaryData.ts profession medians averaged per sector,
 * then reduced by 10% Ticino regional factor (Ticino pays ~10% below
 * Swiss national average per UST/BFS Lohnstrukturerhebung).
 */

// ── Ticino-adjusted sector salary medians ──────────────────────────────────
// Computed: avg(profession medians from salaryData.ts) × 0.90 Ticino factor
// Rounded to nearest 500.
const TICINO_SECTOR_MEDIANS = {
  IT:             { junior: 65500, mid: 85000,  senior: 110500 },
  Finance:        { junior: 72000, mid: 97000,  senior: 128000 },
  Pharma:         { junior: 69500, mid: 90000,  senior: 115500 },
  Engineering:    { junior: 64000, mid: 84500,  senior: 108500 },
  Healthcare:     { junior: 68500, mid: 94000,  senior: 119500 },
  Retail:         { junior: 50500, mid: 63500,  senior: 77500  },
  Hospitality:    { junior: 51500, mid: 67500,  senior: 85500  },
  Construction:   { junior: 59000, mid: 74500,  senior: 94000  },
  Education:      { junior: 77500, mid: 98000,  senior: 121000 },
  Logistics:      { junior: 54500, mid: 68000,  senior: 84500  },
  Legal:          { junior: 72000, mid: 94500,  senior: 122500 },
  Insurance:      { junior: 65000, mid: 84500,  senior: 107500 },
  Telecom:        { junior: 65500, mid: 85000,  senior: 109000 },
  Marketing:      { junior: 56500, mid: 72500,  senior: 91000  },
  Consulting:     { junior: 68000, mid: 91000,  senior: 118500 },
  MedicalDevices: { junior: 69500, mid: 90000,  senior: 115500 }, // same as Pharma
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
  const minValue = roundTo500(median * 0.85);
  const maxValue = roundTo500(median * 1.15);

  return { minValue, maxValue, level, sectorName };
}

export { TICINO_SECTOR_MEDIANS, CATEGORY_TO_SECTOR, LEVEL_JUNIOR_RE, LEVEL_SENIOR_RE, roundTo500 };
