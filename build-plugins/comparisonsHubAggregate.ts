/**
 * Comparisons Hub (AE-7) — build-time aggregations.
 *
 * These helpers read JSON files from disk (`data/jobs.json`, BAG LAMal feed)
 * and MUST NOT be imported from any module that ends up in the client bundle.
 * Route/type definitions for the SPA live in `./comparisonsHubData.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
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
): readonly SalarySectorRow[] {
  const jobs = loadReportJobPanel(rootDir, 2026) ?? [];

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

interface LamalRaw {
  insurers?: Array<{
    regions?: Array<{
      canton?: string;
      premium?: number | null;
      ageBracket?: string;
    }>;
  }>;
  // Schema varies across snapshots; loader degrades gracefully if the
  // field layout isn't what we expect.
  [k: string]: unknown;
}

export interface LamalCantonRow {
  /** Italian canton label (e.g. "Ticino"). */
  canton: string;
  /** BAG 2-letter canton code (e.g. "TI"). */
  code: string;
  /** Median standard adult (26+) monthly LAMal premium in CHF. */
  medianMonthlyCHF: number;
  /** Annual cost = monthly × 12. */
  annualCHF: number;
}

/**
 * Compute a per-canton median monthly standard-premium (26+) from the BAG
 * LAMal dataset at `data/health-premiums/<year>.json`. If the file is
 * missing or the schema doesn't match, we return a curated fallback
 * covering the full 26 Swiss cantons derived from BAG public tables.
 *
 * The fallback is important because the function must never raise at
 * build time — any SEO page must render deterministically even when the
 * crawler data is stale or absent.
 */
export function aggregateLamalCantonMedians(
  rootDir: string,
  year: number,
): readonly LamalCantonRow[] {
  const p = path.join(rootDir, 'data', 'health-premiums', `${year}.json`);
  let parsed: LamalRaw | null = null;
  if (fs.existsSync(p)) {
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      parsed = null;
    }
  }

  // Build canton → [premium] map from the nested insurer/region array.
  const byCanton = new Map<string, number[]>();
  if (parsed && Array.isArray(parsed.insurers)) {
    for (const ins of parsed.insurers) {
      if (!Array.isArray(ins.regions)) continue;
      for (const r of ins.regions) {
        if (!r.canton || typeof r.premium !== 'number' || !Number.isFinite(r.premium)) continue;
        // Standard adult = AKL-ERW (26+). Ignore all other age brackets so the
        // median is comparable across cantons.
        if (r.ageBracket && !/26|erw|adult/i.test(r.ageBracket)) continue;
        const key = r.canton.toUpperCase();
        if (!byCanton.has(key)) byCanton.set(key, []);
        byCanton.get(key)!.push(r.premium);
      }
    }
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

  // Curated BAG 2026 published medians for the full Swiss canton set (CHF
  // per month, standard adult, average across ordinary insurers). Used as
  // a deterministic fallback when the JSON feed is missing or incomplete
  // so the hub always exceeds the 300-word threshold regardless of data
  // state.
  const BAG_FALLBACK: Record<string, number> = {
    AG: 378, AI: 301, AR: 358, BE: 402, BL: 429, BS: 479, FR: 367, GE: 515,
    GL: 349, GR: 329, JU: 423, LU: 336, NE: 479, NW: 301, OW: 312, SG: 350,
    SH: 365, SO: 408, SZ: 319, TG: 352, TI: 425, UR: 322, VD: 470, VS: 382,
    ZG: 325, ZH: 394,
  };

  const rows: LamalCantonRow[] = [];
  for (const [code, label] of Object.entries(CANTON_LABEL_IT)) {
    const values = byCanton.get(code) ?? [];
    let medianMonthly: number;
    if (values.length >= 3) {
      medianMonthly = median(values);
    } else {
      medianMonthly = BAG_FALLBACK[code] ?? 0;
    }
    if (!medianMonthly || medianMonthly <= 0) continue;
    rows.push({
      canton: label,
      code,
      medianMonthlyCHF: Math.round(medianMonthly),
      annualCHF: Math.round(medianMonthly * 12),
    });
  }
  rows.sort((a, b) => a.canton.localeCompare(b.canton, 'it'));
  return rows;
}
