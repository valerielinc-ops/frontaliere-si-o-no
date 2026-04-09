// ─── Swiss-Italian Salary Data for Cross-Border Workers ─────────────────────
//
// ── Data sources ────────────────────────────────────────────────────────────
// 1. USTAT Ticino — Rilevazione svizzera della struttura dei salari (RSS)
//    cubi_RSS_02, anno 2024, Canton Ticino, settore privato
//    https://www3.ti.ch/DFE/DR/USTAT/allegati/cubo/cubi_RSS_02_csv.zip
//    55 NOGA sectors, p10/p25/p50/p75/p90 percentiles, by position/gender/education/residency
//
// 2. CCL/GAV Ticino — Collective labor agreement minimum salary tables
//    Edilizia (OCST CCL 2023-2025), Ristorazione (L-GAV/CCNL 2024)
//    Canton TI minimum wage: CHF 20.00-20.50/hr
//    Sources: ti.ch/usml, gastrosuisse.ch, ocst.ch
//
// 3. ISTAT/INPS — Italian salary survey 2024
//    INPS Osservatorio lavoratori dipendenti (settore privato)
//    Nord-Ovest average: €28,852 lordi/anno
//    Dirigenti: €104,778, Quadri: €56,416, Impiegati: €32,174, Operai: €25,522
//    Sources: inps.it, istat.it (Retribuzioni contrattuali per settore ATECO)
//
// 4. BFS/UST Lohnstrukturerhebung (LSE) 2024 — Swiss national reference
//    https://www.bfs.admin.ch/bfs/en/home/statistics/work-income.html
//
// ── Key facts (Ticino 2024) ─────────────────────────────────────────────────
// Total private-sector employees: 153,987
// Overall median: CHF 5,393/month = CHF 64,716/year
// Ticino/National ratio: ~82%
// Frontalieri: CHF 4,800/mo (89% of Ticino total, 71% of national)
// Gender gap: 11.8% overall (ranges 0% in social services to 42.5% in fin. services)
// Education premium: base→secondary +20%, secondary→tertiary +24%
// All figures: annual gross. CH = CHF, IT = EUR. Tuple = [min, median, max]
//
// ── Italian salary methodology ──────────────────────────────────────────────
// IT-side figures use INPS 2024 data for Nord-Ovest, calibrated per sector:
//   - Finance/Legal/Pharma: above national average (CCNL Credito, CCNL Chimico)
//   - Hospitality/Retail: below average (CCNL Turismo, CCNL Commercio)
//   - Position mapping: junior≈impiegato entry, mid≈impiegato senior, senior≈quadro

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

/** Per-sector metadata from USTAT 2024 + CCL + ISTAT */
export interface SectorMetadata {
  /** Total employees in Ticino private sector (USTAT 2024) */
  employeeCount: number;
  /** Frontalieri/total salary ratio — 1.0 = no gap (USTAT 2024) */
  frontialieriRatio: number;
  /** Gender pay gap: (M−F)/M as percentage (USTAT 2024) */
  genderGapPercent: number;
  /** Education premium: tertiary/base salary ratio (USTAT 2024) */
  educationPremiumRatio: number;
  /** CCL/GAV minimum annual salary floor in CHF, or cantonal minimum */
  cclMinimumAnnual: number;
  /** p25/p50 ratio — how far low earners are below median */
  p25Ratio: number;
  /** p75/p50 ratio — how far high earners are above median */
  p75Ratio: number;
  /** Salary growth 2008→2024, compound annual growth rate (%) */
  historicalCAGR: number;
  /** NOGA 2008 sector code references */
  nogaCodes: string;
}

// ─── 21 sectors × 4-6 professions ─────────────────────────────────────────

export const SALARY_DATA: SectorSalaryData[] = [
  {
    id: 'IT',
    // USTAT NOGA 62 (programmazione/consulenza): p50 CHF 7,083/month, 4,161 employees
    // USTAT NOGA 63 (servizi informativi): p50 CHF 4,864/month, 612 employees
    professions: [
      { id: 'softwareDev', ch: { junior: [58000, 68000, 80000], mid: [76000, 88000, 102000], senior: [100000, 120000, 145000] }, it: { junior: [24000, 28000, 33000], mid: [33000, 38000, 44000], senior: [44000, 52000, 62000] } },
      { id: 'dataScientist', ch: { junior: [62000, 72000, 84000], mid: [82000, 95000, 110000], senior: [108000, 128000, 150000] }, it: { junior: [26000, 30000, 35000], mid: [35000, 42000, 50000], senior: [48000, 56000, 65000] } },
      { id: 'devopsEngineer', ch: { junior: [60000, 70000, 82000], mid: [78000, 90000, 105000], senior: [102000, 122000, 145000] }, it: { junior: [25000, 29000, 34000], mid: [34000, 40000, 47000], senior: [46000, 54000, 63000] } },
      { id: 'uxDesigner', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [85000, 100000, 118000] }, it: { junior: [21000, 25000, 30000], mid: [28000, 34000, 40000], senior: [38000, 46000, 55000] } },
      { id: 'cybersecurity', ch: { junior: [64000, 74000, 86000], mid: [84000, 98000, 114000], senior: [112000, 132000, 155000] }, it: { junior: [27000, 32000, 37000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
    ],
  },
  {
    id: 'Finance',
    // USTAT NOGA 64 (servizi finanziari): p50 CHF 8,431/month, 3,636 employees
    // USTAT NOGA 66 (attività ausiliarie fin./assic.): p50 CHF 8,167/month, 3,810 employees
    professions: [
      { id: 'financialAnalyst', ch: { junior: [65000, 76000, 88000], mid: [85000, 100000, 118000], senior: [115000, 140000, 168000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 52000], senior: [50000, 62000, 75000] } },
      { id: 'complianceOfficer', ch: { junior: [68000, 78000, 90000], mid: [88000, 105000, 122000], senior: [120000, 145000, 172000] }, it: { junior: [30000, 35000, 40000], mid: [40000, 48000, 55000], senior: [55000, 65000, 78000] } },
      { id: 'portfolioManager', ch: { junior: [75000, 88000, 105000], mid: [105000, 130000, 155000], senior: [148000, 180000, 220000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 100000] } },
      { id: 'bankClerk', ch: { junior: [52000, 60000, 68000], mid: [65000, 76000, 86000], senior: [82000, 94000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [36000, 42000, 48000] } },
      { id: 'accountant', ch: { junior: [58000, 68000, 78000], mid: [76000, 90000, 105000], senior: [100000, 120000, 142000] }, it: { junior: [24000, 28000, 33000], mid: [32000, 38000, 45000], senior: [42000, 50000, 60000] } },
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
    // USTAT NOGA 86 (servizi sanitari): p50 CHF 5,878/month, 11,315 employees
    // USTAT NOGA 88 (assistenza sociale non resid.): p50 CHF 6,759/month, 3,447 employees
    professions: [
      { id: 'nurse', ch: { junior: [55000, 63000, 72000], mid: [68000, 80000, 92000], senior: [88000, 104000, 118000] }, it: { junior: [22000, 25000, 28000], mid: [28000, 32000, 36000], senior: [34000, 40000, 45000] } },
      { id: 'generalPractitioner', ch: { junior: [82000, 96000, 115000], mid: [115000, 145000, 175000], senior: [165000, 195000, 235000] }, it: { junior: [35000, 42000, 50000], mid: [50000, 62000, 75000], senior: [72000, 85000, 100000] } },
      { id: 'physiotherapist', ch: { junior: [50000, 58000, 66000], mid: [64000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 32000, 36000], senior: [34000, 40000, 48000] } },
      { id: 'pharmacist', ch: { junior: [62000, 72000, 84000], mid: [80000, 94000, 108000], senior: [102000, 120000, 140000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'socialWorker', ch: { junior: [54000, 64000, 74000], mid: [68000, 80000, 92000], senior: [86000, 100000, 116000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
    ],
  },
  {
    id: 'Retail',
    // USTAT NOGA 47 (commercio al dettaglio): p50 CHF 4,736/month, 9,307 employees
    // USTAT NOGA 46 (commercio all'ingrosso): p50 CHF 5,551/month, 10,499 employees
    // USTAT NOGA 45 (commercio autoveicoli): p50 CHF 5,784/month, 3,976 employees
    professions: [
      { id: 'storeManager', ch: { junior: [48000, 56000, 65000], mid: [62000, 72000, 84000], senior: [78000, 92000, 108000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 32000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'buyer', ch: { junior: [50000, 58000, 68000], mid: [66000, 78000, 90000], senior: [84000, 98000, 115000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 45000, 52000] } },
      { id: 'visualMerchandiser', ch: { junior: [44000, 50000, 58000], mid: [55000, 64000, 75000], senior: [70000, 82000, 96000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'salesAssociate', ch: { junior: [42000, 48000, 55000], mid: [52000, 58000, 65000], senior: [62000, 70000, 80000] }, it: { junior: [18000, 21000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
      { id: 'ecommerceManager', ch: { junior: [54000, 62000, 72000], mid: [70000, 82000, 96000], senior: [90000, 108000, 126000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
    ],
  },
  {
    id: 'Hospitality',
    // USTAT NOGA 55 (servizi di alloggio): p50 CHF 4,414/month, 4,709 employees
    // USTAT NOGA 56 (servizi di ristorazione): p50 CHF 4,066/month, 7,702 employees
    // CCL L-GAV/CCNL: Cat. Ia CHF 3,666/mo, Cat. IIIa CHF 4,470/mo, Cat. IV CHF 5,225/mo
    professions: [
      { id: 'chef', ch: { junior: [44000, 50000, 58000], mid: [56000, 65000, 76000], senior: [72000, 84000, 98000] }, it: { junior: [18000, 22000, 26000], mid: [24000, 28000, 33000], senior: [30000, 36000, 42000] } },
      { id: 'hotelManager', ch: { junior: [52000, 62000, 72000], mid: [70000, 84000, 98000], senior: [92000, 110000, 130000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 40000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'receptionist', ch: { junior: [40000, 46000, 52000], mid: [48000, 56000, 64000], senior: [60000, 70000, 80000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 35000] } },
      { id: 'sommelier', ch: { junior: [44000, 52000, 60000], mid: [58000, 68000, 80000], senior: [74000, 86000, 100000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [32000, 38000, 45000] } },
      { id: 'eventCoordinator', ch: { junior: [46000, 54000, 62000], mid: [60000, 70000, 82000], senior: [78000, 90000, 106000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 32000, 38000], senior: [34000, 42000, 50000] } },
    ],
  },
  {
    id: 'Construction',
    // USTAT NOGA 41 (costruzione edifici): p50 CHF 6,043/month, 5,862 employees
    // USTAT NOGA 42 (ingegneria civile): p50 CHF 6,149/month, 542 employees
    // USTAT NOGA 43 (lavori specializzati): p50 CHF 5,653/month, 7,923 employees
    // CCL OCST 2023-2025: Cat. C CHF 4,673/mo, Cat. Q CHF 5,738/mo, V CHF 6,082/mo
    professions: [
      { id: 'siteManager', ch: { junior: [58000, 68000, 78000], mid: [76000, 88000, 102000], senior: [98000, 115000, 132000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [45000, 55000, 65000] } },
      { id: 'architect', ch: { junior: [54000, 64000, 74000], mid: [72000, 84000, 98000], senior: [94000, 112000, 130000] }, it: { junior: [25000, 30000, 35000], mid: [32000, 38000, 45000], senior: [42000, 50000, 60000] } },
      { id: 'electrician', ch: { junior: [48000, 56000, 64000], mid: [60000, 70000, 80000], senior: [76000, 88000, 100000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'carpenter', ch: { junior: [46000, 54000, 62000], mid: [58000, 68000, 78000], senior: [72000, 84000, 96000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
      { id: 'plumber', ch: { junior: [48000, 56000, 64000], mid: [58000, 68000, 78000], senior: [74000, 86000, 98000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
    ],
  },
  {
    id: 'Education',
    // USTAT NOGA 85 (istruzione): p50 CHF 5,410/month, 2,310 employees
    // Note: Ticino education salaries significantly lower than Zurich/Bern (−7.6% since 2008)
    professions: [
      { id: 'primaryTeacher', ch: { junior: [60000, 68000, 78000], mid: [76000, 86000, 95000], senior: [90000, 102000, 112000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 42000] } },
      { id: 'professor', ch: { junior: [78000, 92000, 110000], mid: [108000, 130000, 155000], senior: [145000, 175000, 210000] }, it: { junior: [35000, 42000, 50000], mid: [48000, 58000, 70000], senior: [65000, 80000, 95000] } },
      { id: 'specialEdTeacher', ch: { junior: [62000, 72000, 82000], mid: [78000, 88000, 100000], senior: [94000, 108000, 122000] }, it: { junior: [24000, 28000, 32000], mid: [28000, 34000, 38000], senior: [36000, 42000, 48000] } },
      { id: 'researcher', ch: { junior: [52000, 62000, 72000], mid: [68000, 82000, 96000], senior: [90000, 108000, 128000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
    ],
  },
  {
    id: 'Logistics',
    // USTAT NOGA 49 (trasporti terrestri): p50 CHF 5,587/month, 3,345 employees
    // USTAT NOGA 52 (magazzinaggio): p50 CHF 4,557/month, 1,647 employees
    // USTAT NOGA 82 (attività amm. e supporto): p50 CHF 4,345/month, 648 employees
    professions: [
      { id: 'supplyChainMgr', ch: { junior: [58000, 68000, 80000], mid: [78000, 92000, 106000], senior: [100000, 118000, 138000] }, it: { junior: [28000, 32000, 38000], mid: [35000, 42000, 48000], senior: [48000, 55000, 65000] } },
      { id: 'warehouseWorker', ch: { junior: [42000, 48000, 55000], mid: [50000, 58000, 66000], senior: [60000, 70000, 80000] }, it: { junior: [18000, 20000, 24000], mid: [22000, 25000, 28000], senior: [26000, 30000, 34000] } },
      { id: 'importExport', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 44000, 52000] } },
      { id: 'truckDriver', ch: { junior: [46000, 52000, 60000], mid: [55000, 64000, 74000], senior: [68000, 78000, 88000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
      { id: 'customsBroker', ch: { junior: [50000, 58000, 68000], mid: [64000, 76000, 88000], senior: [80000, 94000, 110000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [36000, 42000, 50000] } },
    ],
  },
  {
    id: 'Legal',
    // USTAT NOGA 69 (attività legali e contabilità): p50 CHF 6,308/month, 4,339 employees
    professions: [
      { id: 'lawyer', ch: { junior: [68000, 78000, 90000], mid: [88000, 105000, 125000], senior: [122000, 148000, 178000] }, it: { junior: [28000, 35000, 42000], mid: [40000, 50000, 62000], senior: [58000, 72000, 88000] } },
      { id: 'paralegal', ch: { junior: [50000, 58000, 68000], mid: [64000, 74000, 86000], senior: [78000, 92000, 106000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 48000] } },
      { id: 'notary', ch: { junior: [72000, 84000, 98000], mid: [95000, 115000, 138000], senior: [132000, 158000, 188000] }, it: { junior: [32000, 38000, 45000], mid: [45000, 55000, 68000], senior: [65000, 80000, 95000] } },
      { id: 'legalCompliance', ch: { junior: [62000, 72000, 84000], mid: [80000, 95000, 110000], senior: [105000, 125000, 148000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 68000] } },
      { id: 'taxAdvisor', ch: { junior: [60000, 70000, 82000], mid: [78000, 92000, 108000], senior: [100000, 120000, 142000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [45000, 55000, 65000] } },
    ],
  },
  {
    id: 'Insurance',
    // USTAT NOGA 68 (attività immobiliari): p50 CHF 5,851/month, 1,922 employees
    // Note: NOGA 65 (assicurazioni) soppressa per Ticino; using NOGA 68 as proxy
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
    // Mapped to NOGA 62+63 data; telecom roles in Ticino are IT-adjacent
    professions: [
      { id: 'networkEngineer', ch: { junior: [58000, 68000, 80000], mid: [76000, 88000, 102000], senior: [98000, 118000, 140000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 46000], senior: [44000, 52000, 62000] } },
      { id: 'telecomTechnician', ch: { junior: [48000, 56000, 64000], mid: [60000, 70000, 80000], senior: [76000, 88000, 102000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 44000] } },
      { id: 'productManager', ch: { junior: [65000, 76000, 88000], mid: [85000, 100000, 118000], senior: [112000, 134000, 158000] }, it: { junior: [28000, 32000, 38000], mid: [36000, 42000, 50000], senior: [48000, 58000, 70000] } },
      { id: 'salesEngineer', ch: { junior: [58000, 68000, 80000], mid: [78000, 92000, 108000], senior: [102000, 122000, 145000] }, it: { junior: [26000, 30000, 36000], mid: [34000, 40000, 48000], senior: [46000, 55000, 65000] } },
    ],
  },
  {
    id: 'Marketing',
    // USTAT NOGA 73 (pubblicità/ricerche di mercato): p50 CHF 5,506/month, 653 employees
    // USTAT NOGA 58 (attività editoriali): p50 CHF 5,951/month, 445 employees
    professions: [
      { id: 'digitalMarketingMgr', ch: { junior: [54000, 64000, 74000], mid: [72000, 84000, 98000], senior: [92000, 110000, 130000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
      { id: 'copywriter', ch: { junior: [46000, 54000, 62000], mid: [60000, 70000, 80000], senior: [76000, 88000, 102000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 35000], senior: [32000, 38000, 45000] } },
      { id: 'seoSpecialist', ch: { junior: [50000, 58000, 68000], mid: [65000, 76000, 88000], senior: [82000, 96000, 112000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [35000, 42000, 50000] } },
      { id: 'graphicDesigner', ch: { junior: [46000, 54000, 62000], mid: [60000, 70000, 82000], senior: [78000, 90000, 106000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [34000, 40000, 48000] } },
      { id: 'contentManager', ch: { junior: [48000, 56000, 66000], mid: [62000, 74000, 86000], senior: [80000, 94000, 110000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 34000, 40000], senior: [36000, 44000, 52000] } },
    ],
  },
  {
    id: 'Consulting',
    // USTAT NOGA 71 (studi di architettura/ingegneria): p50 CHF 6,320/month, 5,850 employees
    // USTAT NOGA 74 (altre attività professionali): p50 CHF 5,093/month, 766 employees
    professions: [
      { id: 'mgmtConsultant', ch: { junior: [62000, 72000, 84000], mid: [82000, 98000, 115000], senior: [110000, 132000, 156000] }, it: { junior: [28000, 32000, 38000], mid: [38000, 45000, 55000], senior: [52000, 65000, 78000] } },
      { id: 'strategyAnalyst', ch: { junior: [56000, 66000, 78000], mid: [74000, 88000, 104000], senior: [100000, 120000, 142000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [46000, 55000, 68000] } },
      { id: 'itConsultant', ch: { junior: [60000, 70000, 82000], mid: [78000, 92000, 108000], senior: [106000, 126000, 148000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 48000], senior: [48000, 56000, 65000] } },
      { id: 'hrConsultant', ch: { junior: [52000, 60000, 70000], mid: [66000, 78000, 92000], senior: [86000, 102000, 120000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
      { id: 'envConsultant', ch: { junior: [54000, 64000, 76000], mid: [72000, 86000, 100000], senior: [96000, 114000, 134000] }, it: { junior: [24000, 28000, 34000], mid: [32000, 38000, 46000], senior: [42000, 52000, 62000] } },
    ],
  },
  // ── New sectors from USTAT 2024 ──────────────────────────────────────────
  {
    id: 'Energy',
    // USTAT NOGA 35 (fornitura di energia elettrica, gas, vapore): p50 CHF 7,542/month, 901 employees
    // Highest-paying sector in Ticino after finance. Growth +19.6% since 2008.
    professions: [
      { id: 'energyEngineer', ch: { junior: [68000, 80000, 94000], mid: [90000, 106000, 124000], senior: [120000, 142000, 168000] }, it: { junior: [30000, 35000, 42000], mid: [40000, 48000, 56000], senior: [52000, 62000, 75000] } },
      { id: 'gridOperator', ch: { junior: [62000, 72000, 84000], mid: [80000, 94000, 108000], senior: [102000, 120000, 140000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 46000], senior: [44000, 52000, 62000] } },
      { id: 'renewableSpecialist', ch: { junior: [60000, 70000, 82000], mid: [78000, 92000, 108000], senior: [104000, 124000, 146000] }, it: { junior: [26000, 30000, 36000], mid: [34000, 40000, 48000], senior: [46000, 55000, 65000] } },
      { id: 'utilityTechnician', ch: { junior: [56000, 66000, 76000], mid: [72000, 84000, 98000], senior: [94000, 110000, 128000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 56000] } },
    ],
  },
  {
    id: 'FoodIndustry',
    // USTAT NOGA 10 (industrie alimentari): p50 CHF 4,344/month, 2,246 employees
    // Low pay, small gender gap (6.4%), high frontalieri ratio (0.96). Growth +6.4% since 2008.
    professions: [
      { id: 'foodTechnologist', ch: { junior: [48000, 56000, 64000], mid: [62000, 72000, 84000], senior: [80000, 94000, 110000] }, it: { junior: [22000, 26000, 30000], mid: [28000, 33000, 38000], senior: [36000, 42000, 50000] } },
      { id: 'qualityController', ch: { junior: [44000, 52000, 60000], mid: [56000, 66000, 76000], senior: [72000, 84000, 98000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [32000, 38000, 44000] } },
      { id: 'productionSupervisor', ch: { junior: [46000, 54000, 64000], mid: [60000, 72000, 84000], senior: [78000, 92000, 108000] }, it: { junior: [22000, 25000, 30000], mid: [28000, 33000, 38000], senior: [34000, 40000, 48000] } },
      { id: 'foodSafetyOfficer', ch: { junior: [50000, 58000, 68000], mid: [64000, 76000, 88000], senior: [84000, 98000, 114000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 44000, 52000] } },
    ],
  },
  {
    id: 'Manufacturing',
    // USTAT NOGA 32 (altre industrie manifatturiere): p50 CHF 4,087/month, 4,154 employees
    // USTAT NOGA 24 (attività metallurgiche): p50 CHF 4,648/month, 2,318 employees
    // Large frontalieri presence (0.96), modest growth (+1.4% since 2008)
    professions: [
      { id: 'cncOperator', ch: { junior: [44000, 52000, 60000], mid: [56000, 66000, 76000], senior: [72000, 84000, 96000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
      { id: 'industrialDesigner', ch: { junior: [50000, 58000, 68000], mid: [66000, 78000, 90000], senior: [86000, 100000, 118000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 42000], senior: [40000, 48000, 56000] } },
      { id: 'maintenanceTech', ch: { junior: [46000, 54000, 62000], mid: [58000, 68000, 78000], senior: [74000, 86000, 98000] }, it: { junior: [22000, 25000, 28000], mid: [26000, 30000, 34000], senior: [30000, 36000, 42000] } },
      { id: 'productionManager', ch: { junior: [54000, 64000, 76000], mid: [72000, 86000, 100000], senior: [96000, 114000, 134000] }, it: { junior: [26000, 30000, 36000], mid: [34000, 40000, 48000], senior: [44000, 52000, 62000] } },
    ],
  },
  {
    id: 'RealEstate',
    // USTAT NOGA 68 (attività immobiliari): p50 CHF 5,851/month, 1,922 employees
    // Moderate frontalieri discount (0.89), significant gender gap (13.6%). Growth +8.3% since 2008.
    professions: [
      { id: 'propertyManager', ch: { junior: [52000, 62000, 72000], mid: [68000, 80000, 94000], senior: [88000, 104000, 122000] }, it: { junior: [24000, 28000, 33000], mid: [30000, 36000, 42000], senior: [40000, 48000, 58000] } },
      { id: 'realEstateAgent', ch: { junior: [46000, 56000, 68000], mid: [62000, 76000, 92000], senior: [84000, 100000, 120000] }, it: { junior: [22000, 26000, 32000], mid: [28000, 35000, 44000], senior: [38000, 48000, 60000] } },
      { id: 'facilityManager', ch: { junior: [50000, 58000, 68000], mid: [66000, 78000, 90000], senior: [84000, 98000, 114000] }, it: { junior: [24000, 28000, 32000], mid: [30000, 35000, 40000], senior: [38000, 44000, 52000] } },
      { id: 'buildingValuer', ch: { junior: [56000, 66000, 76000], mid: [74000, 86000, 100000], senior: [94000, 112000, 132000] }, it: { junior: [26000, 30000, 35000], mid: [34000, 40000, 46000], senior: [44000, 52000, 62000] } },
    ],
  },
  {
    id: 'PersonalServices',
    // USTAT NOGA 96 (altre attività di servizi personali): p50 CHF 3,881/month, 1,539 employees
    // USTAT NOGA 93 (attività sportive, intrattenimento): p50 CHF 4,584/month, 2,495 employees
    // Lowest-paying sector. Small gender gap (9.3%), high frontalieri ratio (0.95). Strong growth +17% since 2008.
    professions: [
      { id: 'hairdresser', ch: { junior: [42000, 46000, 52000], mid: [48000, 54000, 62000], senior: [58000, 66000, 76000] }, it: { junior: [16000, 18000, 22000], mid: [20000, 22000, 26000], senior: [24000, 28000, 34000] } },
      { id: 'fitnessTrainer', ch: { junior: [40000, 46000, 54000], mid: [50000, 58000, 68000], senior: [64000, 74000, 86000] }, it: { junior: [16000, 20000, 24000], mid: [22000, 26000, 30000], senior: [28000, 34000, 40000] } },
      { id: 'spaManager', ch: { junior: [46000, 54000, 64000], mid: [60000, 70000, 82000], senior: [78000, 90000, 106000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 32000, 38000], senior: [34000, 40000, 48000] } },
      { id: 'eventOrganizer', ch: { junior: [44000, 52000, 62000], mid: [58000, 68000, 80000], senior: [74000, 86000, 100000] }, it: { junior: [20000, 24000, 28000], mid: [26000, 30000, 36000], senior: [32000, 38000, 46000] } },
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

// ─── Per-sector metadata from USTAT 2024 + CCL + ISTAT ────────────────────
//
// Sources:
// - employeeCount, frontialieriRatio, genderGapPercent, educationPremiumRatio,
//   p25Ratio, p75Ratio, historicalCAGR: USTAT cubi_RSS_02, anno 2024
// - cclMinimumAnnual: CCL/GAV Ticino or cantonal minimum (CHF 41,600 = 20.00/hr × 2080)
//
export const SECTOR_METADATA: Record<string, SectorMetadata> = {
  IT: {
    employeeCount: 4773,
    frontialieriRatio: 0.86,
    genderGapPercent: 12.9,
    educationPremiumRatio: 1.42,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.81,
    p75Ratio: 1.27,
    historicalCAGR: 0.8,
    nogaCodes: '62, 63',
  },
  Finance: {
    employeeCount: 9782,
    frontialieriRatio: 0.73,
    genderGapPercent: 42.5,
    educationPremiumRatio: 1.62,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.78,
    p75Ratio: 1.44,
    historicalCAGR: 0.5,
    nogaCodes: '64, 66',
  },
  Pharma: {
    employeeCount: 5224,
    frontialieriRatio: 0.92,
    genderGapPercent: -3.9,
    educationPremiumRatio: 1.89,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.82,
    p75Ratio: 1.33,
    historicalCAGR: 1.2,
    nogaCodes: '21',
  },
  Engineering: {
    employeeCount: 5850,
    frontialieriRatio: 0.89,
    genderGapPercent: 15.2,
    educationPremiumRatio: 1.55,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.84,
    p75Ratio: 1.28,
    historicalCAGR: 0.9,
    nogaCodes: '25, 26, 27, 28',
  },
  Healthcare: {
    employeeCount: 14762,
    frontialieriRatio: 1.00,
    genderGapPercent: 8.5,
    educationPremiumRatio: 1.65,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.83,
    p75Ratio: 1.32,
    historicalCAGR: 1.1,
    nogaCodes: '86, 87, 88',
  },
  Retail: {
    employeeCount: 23782,
    frontialieriRatio: 0.88,
    genderGapPercent: 16.8,
    educationPremiumRatio: 1.35,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.85,
    p75Ratio: 1.24,
    historicalCAGR: 0.6,
    nogaCodes: '45, 46, 47',
  },
  Hospitality: {
    employeeCount: 12411,
    frontialieriRatio: 0.94,
    genderGapPercent: 7.4,
    educationPremiumRatio: 1.18,
    cclMinimumAnnual: 47658,
    p25Ratio: 0.87,
    p75Ratio: 1.18,
    historicalCAGR: 0.7,
    nogaCodes: '55, 56',
  },
  Construction: {
    employeeCount: 14327,
    frontialieriRatio: 0.96,
    genderGapPercent: 5.8,
    educationPremiumRatio: 1.22,
    cclMinimumAnnual: 56076,
    p25Ratio: 0.90,
    p75Ratio: 1.16,
    historicalCAGR: 0.4,
    nogaCodes: '41, 42, 43',
  },
  Education: {
    employeeCount: 2310,
    frontialieriRatio: 0.85,
    genderGapPercent: 10.2,
    educationPremiumRatio: 1.48,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.82,
    p75Ratio: 1.35,
    historicalCAGR: -0.5,
    nogaCodes: '85',
  },
  Logistics: {
    employeeCount: 5640,
    frontialieriRatio: 0.92,
    genderGapPercent: 12.1,
    educationPremiumRatio: 1.30,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.86,
    p75Ratio: 1.22,
    historicalCAGR: 0.3,
    nogaCodes: '49, 52, 82',
  },
  Legal: {
    employeeCount: 4339,
    frontialieriRatio: 0.82,
    genderGapPercent: 19.3,
    educationPremiumRatio: 1.72,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.80,
    p75Ratio: 1.38,
    historicalCAGR: 0.7,
    nogaCodes: '69',
  },
  Insurance: {
    employeeCount: 1922,
    frontialieriRatio: 0.89,
    genderGapPercent: 13.6,
    educationPremiumRatio: 1.45,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.82,
    p75Ratio: 1.30,
    historicalCAGR: 0.5,
    nogaCodes: '68',
  },
  Telecom: {
    employeeCount: 4773,
    frontialieriRatio: 0.86,
    genderGapPercent: 12.9,
    educationPremiumRatio: 1.42,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.81,
    p75Ratio: 1.27,
    historicalCAGR: 0.8,
    nogaCodes: '61, 62, 63',
  },
  Marketing: {
    employeeCount: 1098,
    frontialieriRatio: 0.87,
    genderGapPercent: 14.5,
    educationPremiumRatio: 1.38,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.83,
    p75Ratio: 1.28,
    historicalCAGR: 0.6,
    nogaCodes: '73, 58',
  },
  Consulting: {
    employeeCount: 6616,
    frontialieriRatio: 0.89,
    genderGapPercent: 15.2,
    educationPremiumRatio: 1.55,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.83,
    p75Ratio: 1.30,
    historicalCAGR: 0.9,
    nogaCodes: '71, 74',
  },
  Energy: {
    employeeCount: 901,
    frontialieriRatio: 0.90,
    genderGapPercent: 11.0,
    educationPremiumRatio: 1.50,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.84,
    p75Ratio: 1.26,
    historicalCAGR: 1.2,
    nogaCodes: '35',
  },
  FoodIndustry: {
    employeeCount: 2246,
    frontialieriRatio: 0.96,
    genderGapPercent: 6.4,
    educationPremiumRatio: 1.15,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.88,
    p75Ratio: 1.18,
    historicalCAGR: 0.4,
    nogaCodes: '10',
  },
  Manufacturing: {
    employeeCount: 6472,
    frontialieriRatio: 0.96,
    genderGapPercent: 9.8,
    educationPremiumRatio: 1.25,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.87,
    p75Ratio: 1.20,
    historicalCAGR: 0.1,
    nogaCodes: '24, 32',
  },
  RealEstate: {
    employeeCount: 1922,
    frontialieriRatio: 0.89,
    genderGapPercent: 13.6,
    educationPremiumRatio: 1.45,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.82,
    p75Ratio: 1.30,
    historicalCAGR: 0.5,
    nogaCodes: '68',
  },
  PersonalServices: {
    employeeCount: 4034,
    frontialieriRatio: 0.95,
    genderGapPercent: 9.3,
    educationPremiumRatio: 1.12,
    cclMinimumAnnual: 41600,
    p25Ratio: 0.88,
    p75Ratio: 1.16,
    historicalCAGR: 1.1,
    nogaCodes: '93, 96',
  },
};
