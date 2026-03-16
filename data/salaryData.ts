// ─── Swiss-Italian Salary Data for Cross-Border Workers ─────────────────────
// Source: UST/BFS Lohnstrukturerhebung 2022-2024, SECO, jobs.ch, michael-page.ch
//         ISTAT, Glassdoor Italy — Ticino-adjusted (10-15% below Swiss national avg)
// All figures: annual gross. CH = CHF, IT = EUR
// Tuple format: [min, median, max]

export type SalaryLevel = 'junior' | 'mid' | 'senior';
export type SalaryTuple = [number, number, number]; // [min, median, max]

export interface ProfessionSalary {
  id: string;
  ch: Record<SalaryLevel, SalaryTuple>;
  it: Record<SalaryLevel, SalaryTuple>;
}

export interface SectorSalaryData {
  id: string;
  professions: ProfessionSalary[];
}

// ─── 15 sectors × 4 professions = 60 profession entries ────────────────────

export const SALARY_DATA: SectorSalaryData[] = [
  {
    id: 'IT',
    professions: [
      { id: 'softwareDev', ch: { junior: [62000, 72000, 82000], mid: [82000, 95000, 110000], senior: [105000, 125000, 148000] }, it: { junior: [24000, 28000, 33000], mid: [33000, 38000, 44000], senior: [44000, 52000, 62000] } },
      { id: 'dataScientist', ch: { junior: [68000, 78000, 88000], mid: [88000, 100000, 115000], senior: [112000, 130000, 152000] }, it: { junior: [26000, 30000, 35000], mid: [35000, 42000, 50000], senior: [48000, 56000, 65000] } },
      { id: 'devopsEngineer', ch: { junior: [65000, 75000, 85000], mid: [85000, 98000, 112000], senior: [108000, 128000, 150000] }, it: { junior: [25000, 29000, 34000], mid: [34000, 40000, 47000], senior: [46000, 54000, 63000] } },
      { id: 'uxDesigner', ch: { junior: [55000, 65000, 75000], mid: [72000, 85000, 98000], senior: [92000, 108000, 125000] }, it: { junior: [21000, 25000, 30000], mid: [28000, 34000, 40000], senior: [38000, 46000, 55000] } },
    ],
  },
  {
    id: 'Finance',
    professions: [
      { id: 'financialAnalyst', ch: { junior: [70000, 80000, 90000], mid: [90000, 108000, 125000], senior: [120000, 145000, 170000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 52000], senior: [50000, 62000, 75000] } },
      { id: 'complianceOfficer', ch: { junior: [72000, 82000, 92000], mid: [92000, 110000, 128000], senior: [125000, 148000, 175000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 55000], senior: [55000, 65000, 78000] } },
      { id: 'portfolioManager', ch: { junior: [80000, 95000, 110000], mid: [110000, 135000, 160000], senior: [150000, 180000, 220000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 100000] } },
      { id: 'bankClerk', ch: { junior: [55000, 62000, 70000], mid: [68000, 78000, 88000], senior: [85000, 95000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [36000, 42000, 48000] } },
    ],
  },
  {
    id: 'Pharma',
    professions: [
      { id: 'labTechnician', ch: { junior: [58000, 68000, 78000], mid: [75000, 88000, 100000], senior: [95000, 110000, 125000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 55000] } },
      { id: 'regulatoryAffairs', ch: { junior: [72000, 82000, 92000], mid: [92000, 105000, 120000], senior: [115000, 135000, 158000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 55000], senior: [55000, 65000, 78000] } },
      { id: 'clinicalResearch', ch: { junior: [68000, 78000, 88000], mid: [88000, 102000, 118000], senior: [112000, 130000, 150000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
      { id: 'qualityManager', ch: { junior: [70000, 80000, 90000], mid: [90000, 105000, 120000], senior: [118000, 138000, 160000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 56000], senior: [52000, 62000, 72000] } },
    ],
  },
  {
    id: 'Engineering',
    professions: [
      { id: 'mechanicalEng', ch: { junior: [62000, 70000, 80000], mid: [80000, 92000, 105000], senior: [100000, 120000, 140000] }, it: { junior: [25000, 28000, 32000], mid: [32000, 36000, 42000], senior: [42000, 50000, 58000] } },
      { id: 'electricalEng', ch: { junior: [65000, 72000, 82000], mid: [82000, 95000, 108000], senior: [105000, 122000, 142000] }, it: { junior: [26000, 29000, 34000], mid: [34000, 38000, 44000], senior: [44000, 52000, 60000] } },
      { id: 'civilEng', ch: { junior: [60000, 68000, 78000], mid: [78000, 90000, 102000], senior: [98000, 115000, 135000] }, it: { junior: [24000, 27000, 32000], mid: [30000, 35000, 40000], senior: [40000, 48000, 56000] } },
      { id: 'processEng', ch: { junior: [65000, 75000, 85000], mid: [85000, 98000, 112000], senior: [108000, 125000, 145000] }, it: { junior: [27000, 30000, 35000], mid: [35000, 40000, 46000], senior: [45000, 52000, 62000] } },
    ],
  },
  {
    id: 'Healthcare',
    professions: [
      { id: 'nurse', ch: { junior: [58000, 65000, 72000], mid: [72000, 85000, 95000], senior: [90000, 105000, 118000] }, it: { junior: [22000, 25000, 28000], mid: [28000, 32000, 36000], senior: [34000, 40000, 45000] } },
      { id: 'generalPractitioner', ch: { junior: [85000, 100000, 120000], mid: [120000, 150000, 180000], senior: [170000, 200000, 240000] }, it: { junior: [35000, 42000, 50000], mid: [50000, 62000, 75000], senior: [72000, 85000, 100000] } },
      { id: 'physiotherapist', ch: { junior: [55000, 62000, 70000], mid: [70000, 82000, 92000], senior: [88000, 100000, 115000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 32000, 36000], senior: [34000, 40000, 48000] } },
      { id: 'pharmacist', ch: { junior: [68000, 78000, 88000], mid: [88000, 100000, 115000], senior: [108000, 125000, 145000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 48000], senior: [48000, 55000, 65000] } },
    ],
  },
  {
    id: 'Retail',
    professions: [
      { id: 'storeManager', ch: { junior: [52000, 60000, 68000], mid: [65000, 75000, 85000], senior: [80000, 92000, 105000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 32000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'buyer', ch: { junior: [55000, 62000, 72000], mid: [70000, 80000, 92000], senior: [85000, 98000, 112000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 45000, 52000] } },
      { id: 'visualMerchandiser', ch: { junior: [48000, 55000, 62000], mid: [60000, 70000, 80000], senior: [75000, 85000, 98000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'salesAssociate', ch: { junior: [42000, 48000, 55000], mid: [52000, 58000, 65000], senior: [62000, 70000, 80000] }, it: { junior: [18000, 21000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
    ],
  },
  {
    id: 'Hospitality',
    professions: [
      { id: 'chef', ch: { junior: [48000, 55000, 65000], mid: [62000, 72000, 82000], senior: [78000, 90000, 105000] }, it: { junior: [18000, 22000, 26000], mid: [24000, 28000, 33000], senior: [30000, 36000, 42000] } },
      { id: 'hotelManager', ch: { junior: [58000, 68000, 78000], mid: [78000, 92000, 108000], senior: [102000, 120000, 140000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 40000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'receptionist', ch: { junior: [42000, 48000, 55000], mid: [52000, 60000, 68000], senior: [65000, 75000, 85000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
      { id: 'sommelier', ch: { junior: [50000, 58000, 68000], mid: [65000, 75000, 88000], senior: [82000, 95000, 110000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [32000, 38000, 45000] } },
    ],
  },
  {
    id: 'Construction',
    professions: [
      { id: 'siteManager', ch: { junior: [65000, 75000, 85000], mid: [82000, 95000, 110000], senior: [105000, 120000, 138000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'architect', ch: { junior: [60000, 70000, 80000], mid: [78000, 90000, 105000], senior: [100000, 118000, 135000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 38000, 45000], senior: [42000, 50000, 60000] } },
      { id: 'electrician', ch: { junior: [52000, 60000, 68000], mid: [65000, 75000, 85000], senior: [80000, 92000, 105000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'carpenter', ch: { junior: [50000, 58000, 65000], mid: [62000, 72000, 82000], senior: [78000, 88000, 100000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
    ],
  },
  {
    id: 'Education',
    professions: [
      { id: 'primaryTeacher', ch: { junior: [68000, 78000, 85000], mid: [82000, 92000, 100000], senior: [95000, 108000, 118000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'professor', ch: { junior: [95000, 115000, 135000], mid: [130000, 155000, 180000], senior: [170000, 200000, 240000] }, it: { junior: [35000, 42000, 50000], mid: [48000, 58000, 70000], senior: [65000, 80000, 95000] } },
      { id: 'specialEdTeacher', ch: { junior: [72000, 82000, 90000], mid: [88000, 98000, 108000], senior: [100000, 115000, 128000] }, it: { junior: [24000, 28000, 32000], mid: [28000, 34000, 38000], senior: [36000, 42000, 48000] } },
      { id: 'researcher', ch: { junior: [60000, 70000, 80000], mid: [78000, 90000, 105000], senior: [98000, 115000, 135000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
    ],
  },
  {
    id: 'Logistics',
    professions: [
      { id: 'supplyChainMgr', ch: { junior: [65000, 75000, 85000], mid: [85000, 98000, 112000], senior: [108000, 125000, 145000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'warehouseWorker', ch: { junior: [45000, 50000, 58000], mid: [52000, 60000, 68000], senior: [62000, 72000, 82000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 34000] } },
      { id: 'importExport', ch: { junior: [55000, 62000, 72000], mid: [70000, 80000, 92000], senior: [85000, 98000, 112000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 44000, 52000] } },
      { id: 'truckDriver', ch: { junior: [48000, 55000, 62000], mid: [58000, 65000, 75000], senior: [70000, 80000, 90000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
    ],
  },
  {
    id: 'Legal',
    professions: [
      { id: 'lawyer', ch: { junior: [75000, 85000, 98000], mid: [95000, 115000, 135000], senior: [130000, 155000, 185000] }, it: { junior: [28000, 35000, 42000], mid: [40000, 50000, 62000], senior: [58000, 72000, 88000] } },
      { id: 'paralegal', ch: { junior: [55000, 62000, 72000], mid: [68000, 78000, 88000], senior: [82000, 95000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'notary', ch: { junior: [80000, 92000, 105000], mid: [105000, 125000, 148000], senior: [140000, 165000, 195000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 95000] } },
      { id: 'legalCompliance', ch: { junior: [70000, 80000, 90000], mid: [88000, 102000, 118000], senior: [112000, 130000, 152000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
    ],
  },
  {
    id: 'Insurance',
    professions: [
      { id: 'actuary', ch: { junior: [78000, 88000, 100000], mid: [100000, 118000, 135000], senior: [130000, 152000, 178000] }, it: { junior: [30000, 35000, 42000], mid: [40000, 48000, 58000], senior: [55000, 68000, 82000] } },
      { id: 'claimsHandler', ch: { junior: [52000, 60000, 68000], mid: [65000, 75000, 85000], senior: [80000, 92000, 105000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 44000] } },
      { id: 'underwriter', ch: { junior: [65000, 75000, 85000], mid: [82000, 95000, 110000], senior: [105000, 122000, 142000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'insuranceBroker', ch: { junior: [55000, 65000, 78000], mid: [75000, 88000, 102000], senior: [95000, 112000, 132000] }, it: { junior: [24000, 28000, 34000], mid: [32000, 38000, 46000], senior: [42000, 52000, 65000] } },
    ],
  },
  {
    id: 'Telecom',
    professions: [
      { id: 'networkEngineer', ch: { junior: [65000, 75000, 85000], mid: [82000, 95000, 110000], senior: [105000, 125000, 145000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 46000], senior: [44000, 52000, 62000] } },
      { id: 'telecomTechnician', ch: { junior: [52000, 60000, 68000], mid: [65000, 75000, 85000], senior: [80000, 92000, 105000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 44000] } },
      { id: 'productManager', ch: { junior: [72000, 82000, 95000], mid: [92000, 108000, 125000], senior: [118000, 140000, 165000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 70000] } },
      { id: 'salesEngineer', ch: { junior: [65000, 75000, 88000], mid: [85000, 100000, 115000], senior: [108000, 128000, 150000] }, it: { junior: [26000, 30000, 36000], mid: [34000, 40000, 48000], senior: [46000, 55000, 65000] } },
    ],
  },
  {
    id: 'Marketing',
    professions: [
      { id: 'digitalMarketingMgr', ch: { junior: [60000, 70000, 80000], mid: [78000, 90000, 105000], senior: [98000, 115000, 135000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
      { id: 'copywriter', ch: { junior: [50000, 58000, 68000], mid: [65000, 75000, 85000], senior: [80000, 92000, 105000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'seoSpecialist', ch: { junior: [55000, 65000, 75000], mid: [72000, 82000, 95000], senior: [88000, 102000, 118000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 50000] } },
      { id: 'graphicDesigner', ch: { junior: [50000, 58000, 68000], mid: [65000, 75000, 88000], senior: [82000, 95000, 110000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [34000, 40000, 48000] } },
    ],
  },
  {
    id: 'Consulting',
    professions: [
      { id: 'mgmtConsultant', ch: { junior: [72000, 82000, 95000], mid: [95000, 115000, 135000], senior: [128000, 150000, 178000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 55000], senior: [52000, 65000, 78000] } },
      { id: 'strategyAnalyst', ch: { junior: [65000, 75000, 85000], mid: [85000, 100000, 115000], senior: [112000, 130000, 152000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [46000, 55000, 68000] } },
      { id: 'itConsultant', ch: { junior: [68000, 78000, 88000], mid: [88000, 102000, 118000], senior: [115000, 135000, 158000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [48000, 56000, 65000] } },
      { id: 'hrConsultant', ch: { junior: [58000, 68000, 78000], mid: [75000, 88000, 102000], senior: [95000, 112000, 132000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
    ],
  },
];

// ─── Helper functions ──────────────────────────────────────────────────────

/** Get sector average (median) from profession medians */
export function getSectorMedian(sector: SectorSalaryData, level: SalaryLevel, country: 'ch' | 'it'): number {
  const profs = sector.professions;
  const sum = profs.reduce((acc, p) => acc + p[country][level][1], 0);
  return Math.round(sum / profs.length);
}

/** Get salary range for a specific profession — useful for structured job posting data */
export function getJobSalaryRange(
  sectorId: string,
  professionId: string,
  level: SalaryLevel,
): { min: number; max: number; median: number; currency: string } | null {
  const sector = SALARY_DATA.find((s) => s.id === sectorId);
  if (!sector) return null;
  const prof = sector.professions.find((p) => p.id === professionId);
  if (!prof) return null;
  const [min, median, max] = prof.ch[level];
  return { min, max, median, currency: 'CHF' };
}

/** Get all professions flat with sector reference */
export function getAllProfessions(): Array<ProfessionSalary & { sectorId: string }> {
  return SALARY_DATA.flatMap((s) => s.professions.map((p) => ({ ...p, sectorId: s.id })));
}

/** Total profession count */
export const TOTAL_PROFESSIONS = SALARY_DATA.reduce((n, s) => n + s.professions.length, 0);
export const TOTAL_SECTORS = SALARY_DATA.length;
