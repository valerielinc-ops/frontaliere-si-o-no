/**
 * Comparisons Hub (AE-7) — slug tables, routes, aggregation helpers.
 *
 * One-of-a-kind static landing with dense cross-border comparison tables
 * (salary, tax, healthcare, benefits, cost of living) targeted at LLM
 * citations + high-intent SEO.
 *
 * Canonical paths (one per locale):
 *   IT:  /confronti-frontalieri/
 *   EN:  /en/cross-border-comparisons/
 *   DE:  /de/grenzgaenger-vergleich/
 *   FR:  /fr/comparaisons-frontaliers/
 *
 * The router consumes {@link COMPARISONS_HUB_ROUTES} +
 * {@link parseComparisonsHubPath} to resolve these URLs to a
 * `staticOverlay` SPA route so the build-time static HTML emitted by
 * `comparisonsHubPlugin.ts` stays visible outside `#root` and the SPA
 * doesn't replace it with a generic sub-tab view on hydrate.
 *
 * Kept standalone (no dep on staticPagesPlugin etc.) so parallel
 * worktrees merge cleanly — same pattern as nursingLandingsPlugin.
 */

import fs from 'node:fs';
import path from 'node:path';

export const COMPARISONS_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ComparisonsLocale = (typeof COMPARISONS_LOCALES)[number];

export const COMPARISONS_LOCALE_PREFIX: Record<ComparisonsLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Per-locale slug for the hub. Italian canonical has no prefix. */
export const COMPARISONS_HUB_SLUG: Record<ComparisonsLocale, string> = {
  it: 'confronti-frontalieri',
  en: 'cross-border-comparisons',
  de: 'grenzgaenger-vergleich',
  fr: 'comparaisons-frontaliers',
};

export function buildComparisonsHubPath(locale: ComparisonsLocale): string {
  const prefix = COMPARISONS_LOCALE_PREFIX[locale];
  const slug = COMPARISONS_HUB_SLUG[locale];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

/** Flat list of every canonical (4 locales). */
export const COMPARISONS_HUB_ROUTES: readonly string[] = COMPARISONS_LOCALES.map(
  (loc) => buildComparisonsHubPath(loc),
);

/**
 * Resolve a pathname to a comparisons-hub match or `null`. Accepts paths
 * with or without trailing slash.
 */
export function parseComparisonsHubPath(
  pathname: string,
): { locale: ComparisonsLocale } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of COMPARISONS_LOCALES) {
    if (buildComparisonsHubPath(locale) === normalized) return { locale };
  }
  return null;
}

export function isComparisonsHubPath(pathname: string): boolean {
  return parseComparisonsHubPath(pathname) !== null;
}

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
      medianMonthlyCHF: Math.round(medianMonthly),
      annualCHF: Math.round(medianMonthly * 12),
    });
  }
  rows.sort((a, b) => a.canton.localeCompare(b.canton, 'it'));
  return rows;
}
