// ─── Swiss-Italian Salary Data for Cross-Border Workers ─────────────────────
// Primary source: USTAT Ticino — Rilevazione svizzera della struttura dei salari (RSS)
//   cubi_RSS_02, anno 2024, Canton Ticino, settore privato
//   https://www3.ti.ch/DFE/DR/USTAT/allegati/cubo/cubi_RSS_02_csv.zip
// Secondary: BFS/UST Lohnstrukturerhebung (LSE) 2024, SECO, Salarium.bfs.admin.ch
// Italian salaries: ISTAT, Glassdoor Italy, Monster.it
// Ticino factor: ~82% of Swiss national average (USTAT 2024: median CHF 5,393 vs national ~6,600)
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
    // USTAT NOGA 62 (programmazione/consulenza): p50 CHF 7,083/month
    // USTAT NOGA 63 (servizi informativi): p50 CHF 4,864/month
    professions: [
      { id: 'softwareDev', ch: { junior: [58000, 68000, 80000], mid: [76000, 88000, 102000], senior: [100000, 120000, 145000] }, it: { junior: [24000, 28000, 33000], mid: [33000, 38000, 44000], senior: [44000, 52000, 62000] } },
      { id: 'dataScientist', ch: { junior: [62000, 72000, 84000], mid: [82000, 95000, 110000], senior: [108000, 128000, 150000] }, it: { junior: [26000, 30000, 35000], mid: [35000, 42000, 50000], senior: [48000, 56000, 65000] } },
      { id: 'devopsEngineer', ch: { junior: [60000, 70000, 82000], mid: [78000, 90000, 105000], senior: [102000, 122000, 145000] }, it: { junior: [25000, 29000, 34000], mid: [34000, 40000, 47000], senior: [46000, 54000, 63000] } },
      { id: 'uxDesigner', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [85000, 100000, 118000] }, it: { junior: [21000, 25000, 30000], mid: [28000, 34000, 40000], senior: [38000, 46000, 55000] } },
    ],
  },
  {
    id: 'Finance',
    // USTAT NOGA 64 (servizi finanziari): p50 CHF 8,431/month
    // USTAT NOGA 66 (attività ausiliarie fin./assic.): p50 CHF 8,167/month
    professions: [
      { id: 'financialAnalyst', ch: { junior: [65000, 76000, 88000], mid: [85000, 100000, 118000], senior: [115000, 140000, 168000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 52000], senior: [50000, 62000, 75000] } },
      { id: 'complianceOfficer', ch: { junior: [68000, 78000, 90000], mid: [88000, 105000, 122000], senior: [120000, 145000, 172000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 55000], senior: [55000, 65000, 78000] } },
      { id: 'portfolioManager', ch: { junior: [75000, 88000, 105000], mid: [105000, 130000, 155000], senior: [148000, 180000, 220000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 100000] } },
      { id: 'bankClerk', ch: { junior: [52000, 60000, 68000], mid: [65000, 76000, 86000], senior: [82000, 94000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [36000, 42000, 48000] } },
    ],
  },
  {
    id: 'Pharma',
    // USTAT NOGA 21 (farmaceutica): p50 CHF 5,369/month
    // USTAT NOGA 20 (chimica): p50 CHF 5,568/month
    // USTAT NOGA 72 (ricerca scientifica): p50 CHF 6,367/month
    professions: [
      { id: 'labTechnician', ch: { junior: [52000, 62000, 72000], mid: [68000, 80000, 92000], senior: [88000, 105000, 122000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 55000] } },
      { id: 'regulatoryAffairs', ch: { junior: [65000, 76000, 88000], mid: [85000, 100000, 115000], senior: [110000, 132000, 155000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 55000], senior: [55000, 65000, 78000] } },
      { id: 'clinicalResearch', ch: { junior: [60000, 70000, 82000], mid: [80000, 95000, 110000], senior: [105000, 125000, 148000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
      { id: 'qualityManager', ch: { junior: [62000, 72000, 84000], mid: [82000, 98000, 114000], senior: [112000, 135000, 158000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 56000], senior: [52000, 62000, 72000] } },
    ],
  },
  {
    id: 'Engineering',
    // USTAT NOGA 28 (macchinari): p50 CHF 5,740/month
    // USTAT NOGA 25 (prodotti in metallo): p50 CHF 4,668/month
    // USTAT NOGA 27 (apparecchi elettrici): p50 CHF 4,389/month
    professions: [
      { id: 'mechanicalEng', ch: { junior: [52000, 60000, 70000], mid: [68000, 80000, 92000], senior: [90000, 108000, 128000] }, it: { junior: [25000, 28000, 32000], mid: [32000, 36000, 42000], senior: [42000, 50000, 58000] } },
      { id: 'electricalEng', ch: { junior: [55000, 64000, 74000], mid: [72000, 84000, 98000], senior: [95000, 112000, 132000] }, it: { junior: [26000, 29000, 34000], mid: [34000, 38000, 44000], senior: [44000, 52000, 60000] } },
      { id: 'civilEng', ch: { junior: [50000, 58000, 68000], mid: [66000, 78000, 90000], senior: [88000, 105000, 125000] }, it: { junior: [24000, 27000, 32000], mid: [30000, 35000, 40000], senior: [40000, 48000, 56000] } },
      { id: 'processEng', ch: { junior: [55000, 65000, 76000], mid: [74000, 88000, 102000], senior: [98000, 118000, 140000] }, it: { junior: [27000, 30000, 35000], mid: [35000, 40000, 46000], senior: [45000, 52000, 62000] } },
    ],
  },
  {
    id: 'Healthcare',
    // USTAT NOGA 86 (servizi sanitari): p50 CHF 5,878/month
    // USTAT NOGA 88 (assistenza sociale non resid.): p50 CHF 6,759/month
    professions: [
      { id: 'nurse', ch: { junior: [55000, 63000, 72000], mid: [68000, 80000, 92000], senior: [88000, 104000, 118000] }, it: { junior: [22000, 25000, 28000], mid: [28000, 32000, 36000], senior: [34000, 40000, 45000] } },
      { id: 'generalPractitioner', ch: { junior: [82000, 96000, 115000], mid: [115000, 145000, 175000], senior: [165000, 195000, 235000] }, it: { junior: [35000, 42000, 50000], mid: [50000, 62000, 75000], senior: [72000, 85000, 100000] } },
      { id: 'physiotherapist', ch: { junior: [50000, 58000, 66000], mid: [64000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 32000, 36000], senior: [34000, 40000, 48000] } },
      { id: 'pharmacist', ch: { junior: [62000, 72000, 84000], mid: [80000, 94000, 108000], senior: [102000, 120000, 140000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 48000], senior: [48000, 55000, 65000] } },
    ],
  },
  {
    id: 'Retail',
    // USTAT NOGA 47 (commercio al dettaglio): p50 CHF 4,736/month
    // USTAT NOGA 46 (commercio all'ingrosso): p50 CHF 5,551/month
    // USTAT NOGA 45 (commercio autoveicoli): p50 CHF 5,784/month
    professions: [
      { id: 'storeManager', ch: { junior: [48000, 56000, 65000], mid: [62000, 72000, 84000], senior: [78000, 92000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 32000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'buyer', ch: { junior: [50000, 58000, 68000], mid: [66000, 78000, 90000], senior: [84000, 98000, 115000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 45000, 52000] } },
      { id: 'visualMerchandiser', ch: { junior: [44000, 50000, 58000], mid: [55000, 64000, 75000], senior: [70000, 82000, 96000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'salesAssociate', ch: { junior: [42000, 48000, 55000], mid: [52000, 58000, 65000], senior: [62000, 70000, 80000] }, it: { junior: [18000, 21000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
    ],
  },
  {
    id: 'Hospitality',
    // USTAT NOGA 55 (servizi di alloggio): p50 CHF 4,414/month
    // USTAT NOGA 56 (servizi di ristorazione): p50 CHF 4,066/month
    professions: [
      { id: 'chef', ch: { junior: [44000, 50000, 58000], mid: [56000, 65000, 76000], senior: [72000, 84000, 98000] }, it: { junior: [18000, 22000, 26000], mid: [24000, 28000, 33000], senior: [30000, 36000, 42000] } },
      { id: 'hotelManager', ch: { junior: [52000, 62000, 72000], mid: [70000, 84000, 98000], senior: [92000, 110000, 130000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 40000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'receptionist', ch: { junior: [40000, 46000, 52000], mid: [48000, 56000, 64000], senior: [60000, 70000, 80000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
      { id: 'sommelier', ch: { junior: [44000, 52000, 60000], mid: [58000, 68000, 80000], senior: [74000, 86000, 100000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [32000, 38000, 45000] } },
    ],
  },
  {
    id: 'Construction',
    // USTAT NOGA 41 (costruzione edifici): p50 CHF 6,043/month
    // USTAT NOGA 42 (ingegneria civile): p50 CHF 6,149/month
    // USTAT NOGA 43 (lavori specializzati): p50 CHF 5,653/month
    professions: [
      { id: 'siteManager', ch: { junior: [58000, 68000, 78000], mid: [76000, 88000, 102000], senior: [98000, 115000, 132000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'architect', ch: { junior: [54000, 64000, 74000], mid: [72000, 84000, 98000], senior: [94000, 112000, 130000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 38000, 45000], senior: [42000, 50000, 60000] } },
      { id: 'electrician', ch: { junior: [48000, 56000, 64000], mid: [60000, 70000, 80000], senior: [76000, 88000, 100000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'carpenter', ch: { junior: [46000, 54000, 62000], mid: [58000, 68000, 78000], senior: [72000, 84000, 96000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
    ],
  },
  {
    id: 'Education',
    // USTAT NOGA 85 (istruzione): p50 CHF 5,410/month
    // Note: Ticino education salaries are significantly lower than Zurich/Bern
    professions: [
      { id: 'primaryTeacher', ch: { junior: [60000, 68000, 78000], mid: [76000, 86000, 95000], senior: [90000, 102000, 112000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'professor', ch: { junior: [78000, 92000, 110000], mid: [108000, 130000, 155000], senior: [145000, 175000, 210000] }, it: { junior: [35000, 42000, 50000], mid: [48000, 58000, 70000], senior: [65000, 80000, 95000] } },
      { id: 'specialEdTeacher', ch: { junior: [62000, 72000, 82000], mid: [78000, 88000, 100000], senior: [94000, 108000, 122000] }, it: { junior: [24000, 28000, 32000], mid: [28000, 34000, 38000], senior: [36000, 42000, 48000] } },
      { id: 'researcher', ch: { junior: [52000, 62000, 72000], mid: [68000, 82000, 96000], senior: [90000, 108000, 128000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
    ],
  },
  {
    id: 'Logistics',
    // USTAT NOGA 49 (trasporti terrestri): p50 CHF 5,587/month
    // USTAT NOGA 52 (magazzinaggio/supporto trasporti): p50 CHF 4,557/month
    // USTAT NOGA 82 (attività amm. e di supporto): p50 CHF 4,345/month
    professions: [
      { id: 'supplyChainMgr', ch: { junior: [58000, 68000, 80000], mid: [78000, 92000, 106000], senior: [100000, 118000, 138000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'warehouseWorker', ch: { junior: [42000, 48000, 55000], mid: [50000, 58000, 66000], senior: [60000, 70000, 80000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 34000] } },
      { id: 'importExport', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 44000, 52000] } },
      { id: 'truckDriver', ch: { junior: [46000, 52000, 60000], mid: [55000, 64000, 74000], senior: [68000, 78000, 88000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
    ],
  },
  {
    id: 'Legal',
    // USTAT NOGA 69 (attività legali e contabilità): p50 CHF 6,308/month
    professions: [
      { id: 'lawyer', ch: { junior: [68000, 78000, 90000], mid: [88000, 105000, 125000], senior: [122000, 148000, 178000] }, it: { junior: [28000, 35000, 42000], mid: [40000, 50000, 62000], senior: [58000, 72000, 88000] } },
      { id: 'paralegal', ch: { junior: [50000, 58000, 68000], mid: [64000, 74000, 86000], senior: [78000, 92000, 106000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'notary', ch: { junior: [72000, 84000, 98000], mid: [95000, 115000, 138000], senior: [132000, 158000, 188000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 95000] } },
      { id: 'legalCompliance', ch: { junior: [62000, 72000, 84000], mid: [80000, 95000, 110000], senior: [105000, 125000, 148000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
    ],
  },
  {
    id: 'Insurance',
    // USTAT NOGA 68 (attività immobiliari): p50 CHF 5,851/month
    // Note: NOGA 65 (assicurazioni) soppressa per Ticino; using 68 as proxy
    professions: [
      { id: 'actuary', ch: { junior: [70000, 82000, 94000], mid: [92000, 110000, 128000], senior: [124000, 146000, 172000] }, it: { junior: [30000, 35000, 42000], mid: [40000, 48000, 58000], senior: [55000, 68000, 82000] } },
      { id: 'claimsHandler', ch: { junior: [48000, 56000, 64000], mid: [60000, 70000, 80000], senior: [76000, 88000, 102000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 44000] } },
      { id: 'underwriter', ch: { junior: [58000, 68000, 80000], mid: [76000, 90000, 104000], senior: [98000, 116000, 136000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'insuranceBroker', ch: { junior: [50000, 60000, 72000], mid: [68000, 82000, 96000], senior: [90000, 106000, 126000] }, it: { junior: [24000, 28000, 34000], mid: [32000, 38000, 46000], senior: [42000, 52000, 65000] } },
    ],
  },
  {
    id: 'Telecom',
    // USTAT NOGA 61 (telecomunicazioni): soppressa per Ticino
    // Mapped to NOGA 62+35 data; telecom roles in Ticino are IT-adjacent
    professions: [
      { id: 'networkEngineer', ch: { junior: [58000, 68000, 80000], mid: [76000, 88000, 102000], senior: [98000, 118000, 140000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 46000], senior: [44000, 52000, 62000] } },
      { id: 'telecomTechnician', ch: { junior: [48000, 56000, 64000], mid: [60000, 70000, 80000], senior: [76000, 88000, 102000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 44000] } },
      { id: 'productManager', ch: { junior: [65000, 76000, 88000], mid: [85000, 100000, 118000], senior: [112000, 134000, 158000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 70000] } },
      { id: 'salesEngineer', ch: { junior: [58000, 68000, 80000], mid: [78000, 92000, 108000], senior: [102000, 122000, 145000] }, it: { junior: [26000, 30000, 36000], mid: [34000, 40000, 48000], senior: [46000, 55000, 65000] } },
    ],
  },
  {
    id: 'Marketing',
    // USTAT NOGA 73 (pubblicità/ricerche di mercato): p50 CHF 5,506/month
    // USTAT NOGA 58 (attività editoriali): p50 CHF 5,951/month
    professions: [
      { id: 'digitalMarketingMgr', ch: { junior: [54000, 64000, 74000], mid: [72000, 84000, 98000], senior: [92000, 110000, 130000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
      { id: 'copywriter', ch: { junior: [46000, 54000, 62000], mid: [60000, 70000, 80000], senior: [76000, 88000, 102000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'seoSpecialist', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 50000] } },
      { id: 'graphicDesigner', ch: { junior: [46000, 54000, 62000], mid: [60000, 70000, 82000], senior: [78000, 90000, 106000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [34000, 40000, 48000] } },
    ],
  },
  {
    id: 'Consulting',
    // USTAT NOGA 71 (studi di architettura/ingegneria): p50 CHF 6,320/month
    // USTAT NOGA 74 (altre attività professionali): p50 CHF 5,093/month
    professions: [
      { id: 'mgmtConsultant', ch: { junior: [62000, 72000, 84000], mid: [82000, 98000, 115000], senior: [110000, 132000, 156000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 55000], senior: [52000, 65000, 78000] } },
      { id: 'strategyAnalyst', ch: { junior: [56000, 66000, 78000], mid: [74000, 88000, 104000], senior: [100000, 120000, 142000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [46000, 55000, 68000] } },
      { id: 'itConsultant', ch: { junior: [60000, 70000, 82000], mid: [78000, 92000, 108000], senior: [106000, 126000, 148000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [48000, 56000, 65000] } },
      { id: 'hrConsultant', ch: { junior: [52000, 60000, 70000], mid: [66000, 78000, 92000], senior: [86000, 102000, 120000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
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
