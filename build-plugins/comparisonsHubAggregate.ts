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
import { loadReportJobPanel, isReportSalaryJob, type ReportJob } from './shared/reportJobPanel';
import { jobSalaryMidpoint } from './shared/realSalaryMedian';

// ── Salary aggregation from data/jobs.json ──────────────────────


export interface SalarySectorRow {
  /** Raw sector label (as stored in data/jobs.json). */
  sector: string;
  /** Count of observations used to compute medianCHF. */
  count: number;
  /** Median of explicitly annual gross CHF ranges. */
  medianCHF: number;
  /** No comparable Italian salary panel is supplied by the source data. */
  estimatedItalyEUR: number | null;
  /** No ratio is published without comparable observed salaries. */
  ratio: number | null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

/** Same Ticino observation panel and salary policy as the linked annual CSV. */
export function aggregateSalaryBySector(
  rootDir: string,
  topN = 10,
): readonly SalarySectorRow[] | null {
  const jobs = loadReportJobPanel(rootDir, 2026);
  if (jobs === null) return null;

  const withSalary: Array<ReportJob & { mid: number }> = [];
  for (const j of jobs) {
    if (!isReportSalaryJob(j)) continue;
    const mid = jobSalaryMidpoint(j);
    if (mid === null) continue;
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
    rows.push({
      sector,
      count: values.length,
      medianCHF,
      estimatedItalyEUR: null,
      ratio: null,
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
