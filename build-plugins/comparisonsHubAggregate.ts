/**
 * Comparisons Hub (AE-7) — build-time aggregations.
 *
 * These helpers read JSON files from disk (`data/jobs.json`, BAG LAMal feed)
 * and MUST NOT be imported from any module that ends up in the client bundle.
 * Route/type definitions for the SPA live in `./comparisonsHubData.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertDomesticHealthQuotes } from '../scripts/lib/domestic-health-premiums.mjs';
import type { DomesticHealthQuotes } from '../services/healthPremiumResidency';

// ── Salary aggregation from data/jobs.json ──────────────────────

interface RawJob {
  id?: string;
  sector?: string;
  canton?: string;
  location?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
}

export interface SalarySectorRow {
  /** Raw sector label (as stored in data/jobs.json). */
  sector: string;
  /** Count of observations used to compute medianCHF. */
  count: number;
  /** Median annual salary in CHF (gross, 13 months). */
  medianCHF: number;
  /**
   * Paired estimated Italian gross salary for an equivalent role. Derived
   * from publicly reported ratios: Italian averages are ~40-55% of Swiss
   * for the same sector (sources: SECO, ISTAT SILC, INAPP).
   */
  estimatedItalyEUR: number;
  /** Gap ratio (Swiss median CHF / Italy estimate EUR, informative only). */
  ratio: number;
}

/**
 * Sector → ratio of Italian median gross to Swiss median gross in CHF→EUR
 * terms. Conservative anchors based on public aggregate data:
 *   - SECO Swiss salary structure 2024 (aggregate by NOGA sector)
 *   - ISTAT Rilevazione sulla Struttura delle Retribuzioni 2022
 *   - INAPP XXIV Rapporto sul mercato del lavoro 2024
 *
 * Where the sector in data/jobs.json is unusual or not in these anchors
 * we default to the global cross-sector ratio (~0.45).
 */
const IT_RATIO_BY_SECTOR: Record<string, number> = {
  // Keys match the Italian sector labels used in data/jobs.json.
  'Sanità': 0.38,
  'Sanità e assistenza sociale': 0.38,
  'Finanza': 0.42,
  'Finanza e assicurazioni': 0.42,
  'Bancario': 0.42,
  'ICT': 0.48,
  'Informatica': 0.48,
  'Informatica ed elettronica': 0.48,
  'Ingegneria': 0.46,
  'Edilizia': 0.50,
  'Costruzioni': 0.50,
  'Industria': 0.50,
  'Logistica': 0.55,
  'Trasporti': 0.55,
  'Ristorazione': 0.60,
  'Retail': 0.58,
  'Commercio': 0.58,
  'Amministrazione': 0.52,
  'Pubblica amministrazione': 0.52,
  'Istruzione': 0.55,
  'Educazione': 0.55,
};

const DEFAULT_IT_RATIO = 0.45;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function loadJobs(rootDir: string): RawJob[] {
  const p = path.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(raw) ? (raw as RawJob[]) : [];
  } catch {
    return [];
  }
}

/**
 * Aggregate `data/jobs.json` by sector and emit the top-N rows for the
 * salary comparison table. Keeps only sectors with ≥10 observations so the
 * medians are statistically meaningful.
 *
 * Italian counterpart is an *estimate* derived from the sector ratio above
 * and explicitly flagged as such in the table footer. We refuse to invent
 * per-company figures — only a ratio from published aggregate sources.
 */
export function aggregateSalaryBySector(
  rootDir: string,
  topN = 10,
): readonly SalarySectorRow[] {
  const jobs = loadJobs(rootDir);

  const withSalary: Array<RawJob & { mid: number }> = [];
  for (const j of jobs) {
    const min = typeof j.salaryMin === 'number' ? j.salaryMin : null;
    const max = typeof j.salaryMax === 'number' ? j.salaryMax : null;
    if (!min || !max || min <= 0 || max <= 0) continue;
    const currency = (j.currency ?? 'CHF').toUpperCase();
    if (currency !== 'CHF') continue;
    let mid = Math.round((min + max) / 2);
    // Heuristic: < 10k likely monthly — annualise across 13 months.
    if (mid < 10000) mid *= 13;
    if (mid < 20000 || mid > 400000) continue;
    withSalary.push({ ...j, mid });
  }

  const bySector = new Map<string, number[]>();
  for (const j of withSalary) {
    const s = j.sector?.trim();
    if (!s) continue;
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s)!.push(j.mid);
  }

  const rows: SalarySectorRow[] = [];
  for (const [sector, values] of bySector.entries()) {
    if (values.length < 10) continue;
    const medianCHF = median(values);
    const ratio = IT_RATIO_BY_SECTOR[sector] ?? DEFAULT_IT_RATIO;
    // Swiss→Italy: assume CHF ≈ EUR 1.04 for conservative estimate (2026
    // average exchange). Keep the rounding coarse to signal the approximate
    // nature of the pairing.
    const estimatedItalyEUR = Math.round((medianCHF * ratio * 1.04) / 1000) * 1000;
    rows.push({
      sector,
      count: values.length,
      medianCHF,
      estimatedItalyEUR,
      ratio,
    });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, topN);
}

// ── Canton LAMal premium median aggregation ─────────────────────

export interface LamalCantonRow {
  /** Actual year validated against the requested snapshot. */
  year: number;
  /** Italian canton label (e.g. "Ticino"). */
  canton: string;
  /** BAG 2-letter canton code (e.g. "TI"). */
  code: string;
  /** Median standard adult (26+) monthly LAMal premium in CHF. */
  medianMonthlyCHF: number;
  /** Annual cost = monthly × 12. */
  annualCHF: number;
}

/** Median of observed insurer/region standard adult premiums, never a quoted Italy premium. */
export function aggregateLamalCantonMedians(
  rootDir: string,
  year: number,
): readonly LamalCantonRow[] {
  const file = path.join(rootDir, 'data', 'health-premiums', `${year}.json`);
  let quotes: DomesticHealthQuotes;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed?.year !== year || typeof parsed.sourceUrl !== 'string') return [];
    quotes = assertDomesticHealthQuotes(parsed.quotes) as DomesticHealthQuotes;
  } catch {
    return [];
  }
  const byCanton = new Map<string, number[]>();
  for (const [canton, regions] of Object.entries(quotes)) {
    const values: number[] = [];
    for (const insurers of Object.values(regions)) {
      for (const profile of Object.values(insurers)) {
        const premium = profile.ERW?.withoutAccident?.['300']?.standard;
        if (typeof premium === 'number' && Number.isFinite(premium) && premium > 0) values.push(premium);
      }
    }
    byCanton.set(canton, values);
  }

  // Mapping of BAG 2-letter code → localised IT canton label. We always
  // return IT-locale labels in the raw data; copy generators translate as
  // needed.
  const CANTON_LABEL_IT: Record<string, string> = {
    AG: 'Argovia', AI: 'Appenzello Interno', AR: 'Appenzello Esterno', BE: 'Berna',
    BL: 'Basilea-Campagna', BS: 'Basilea-Città', FR: 'Friborgo', GE: 'Ginevra',
    GL: 'Glarona', GR: 'Grigioni', JU: 'Giura', LU: 'Lucerna', NE: 'Neuchâtel',
    NW: 'Nidvaldo', OW: 'Obvaldo', SG: 'San Gallo', SH: 'Sciaffusa', SO: 'Soletta',
    SZ: 'Svitto', TG: 'Turgovia', TI: 'Ticino', UR: 'Uri', VD: 'Vaud',
    VS: 'Vallese', ZG: 'Zugo', ZH: 'Zurigo',
  };

  const rows: LamalCantonRow[] = [];
  for (const [code, label] of Object.entries(CANTON_LABEL_IT)) {
    const values = byCanton.get(code) ?? [];
    if (values.length < 3) continue;
    const medianMonthly = median(values);
    if (!medianMonthly || medianMonthly <= 0) continue;
    rows.push({
      canton: label,
      code,
      year,
      medianMonthlyCHF: Math.round(medianMonthly),
      annualCHF: Math.round(medianMonthly * 12),
    });
  }
  rows.sort((a, b) => a.canton.localeCompare(b.canton, 'it'));
  return rows;
}
