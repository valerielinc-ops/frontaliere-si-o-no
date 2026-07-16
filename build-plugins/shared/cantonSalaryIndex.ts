/**
 * cantonSalaryIndex.ts — per-canton salary index (build / SEO side)
 *
 * TypeScript twin of the canonical data file
 * `data/swiss-canton-salary-index.json`. The numbers are inlined as pure
 * literals because this module sits in the Vite config graph (it is imported,
 * transitively, by vite.config.ts) and JSON imports are NOT reliably
 * transformed at config-eval time — see the calcHref.ts cautionary note and
 * the `no_alias_imports_in_config_graph` rule. To guarantee the literals never
 * drift from the JSON, `tests/swiss-canton-salary-parity.test.ts` asserts that
 * this table equals the JSON byte-for-byte.
 *
 * Methodology: BFS publishes wage medians only for the 7 Grossregionen.
 * Each canton inherits its Grossregion median; salaries are scaled by
 * factor = grossregionMedian / ticinoMedian (Ticino = 1.0). The frontalieri
 * discount applies only to border cantons. Full rationale in the JSON.
 */

import { CANTON_DISPLAY } from './cantonDisplay';

export type Grossregion =
  | 'lemanique'
  | 'mittelland'
  | 'nordwest'
  | 'zurich'
  | 'ostschweiz'
  | 'zentral'
  | 'ticino';

/** BFS LSE 2024 Grossregion median gross monthly wage (CHF). */
export const GROSSREGION_MEDIAN_MONTHLY: Record<Grossregion, number> = {
  lemanique: 6998,
  mittelland: 6964,
  nordwest: 7156,
  zurich: 7502,
  ostschweiz: 6623,
  zentral: 7092,
  ticino: 5708,
};

export const TICINO_MEDIAN_MONTHLY = 5708;
export const NATIONAL_MEDIAN_MONTHLY = 7024;

export const CANTON_TO_GROSSREGION: Record<string, Grossregion> = {
  ZH: 'zurich',
  BE: 'mittelland',
  LU: 'zentral',
  UR: 'zentral',
  SZ: 'zentral',
  OW: 'zentral',
  NW: 'zentral',
  GL: 'ostschweiz',
  ZG: 'zentral',
  FR: 'mittelland',
  SO: 'mittelland',
  BS: 'nordwest',
  BL: 'nordwest',
  SH: 'ostschweiz',
  AR: 'ostschweiz',
  AI: 'ostschweiz',
  SG: 'ostschweiz',
  GR: 'ostschweiz',
  AG: 'nordwest',
  TG: 'ostschweiz',
  TI: 'ticino',
  VD: 'lemanique',
  VS: 'lemanique',
  NE: 'mittelland',
  GE: 'lemanique',
  JU: 'mittelland',
};

export const BORDER_CANTONS: ReadonlySet<string> = new Set([
  'GE', 'TI', 'VD', 'VS', 'BS', 'BL', 'NE', 'JU', 'AG', 'SH', 'TG', 'SG', 'GR',
]);

export const STATUTORY_MIN_WAGE_ANNUAL: Record<string, number> = {
  GE: 51100,
  NE: 44400,
  JU: 44500,
  BS: 43700,
  TI: 41600,
};

export const UNIVERSAL_FLOOR_ANNUAL = 41600;

export const NATIONAL_SECTOR_GAV_FLOOR_ANNUAL: Record<string, number> = {
  Construction: 56076,
  Hospitality: 47658,
};

/** Normalise an arbitrary canton input to a 2-letter BFS code; default 'TI'. */
export function normalizeSalaryCantonCode(code: string | null | undefined): string {
  const c = String(code || '').toUpperCase().trim();
  return /^[A-Z]{2}$/.test(c) && CANTON_TO_GROSSREGION[c] ? c : 'TI';
}

/** Per-canton wage factor relative to Ticino (Ticino = 1.0). */
export function cantonSalaryFactor(code: string | null | undefined): number {
  const region = CANTON_TO_GROSSREGION[normalizeSalaryCantonCode(code)];
  const median = GROSSREGION_MEDIAN_MONTHLY[region];
  return median && TICINO_MEDIAN_MONTHLY ? median / TICINO_MEDIAN_MONTHLY : 1;
}

export function isBorderCanton(code: string | null | undefined): boolean {
  return BORDER_CANTONS.has(normalizeSalaryCantonCode(code));
}

/** Lower-bound annual salary floor for a sector in a (non-TI) canton. */
export function cantonSectorFloor(sectorName: string, code: string | null | undefined): number {
  const c = normalizeSalaryCantonCode(code);
  const gav = NATIONAL_SECTOR_GAV_FLOOR_ANNUAL[sectorName] || 0;
  const statutory = STATUTORY_MIN_WAGE_ANNUAL[c] || UNIVERSAL_FLOOR_ANNUAL;
  return Math.max(gav, statutory);
}

// ── Display-name → canton resolution (for the localized SEO prose) ──────────
// The prose helper receives a localized canton display name (e.g. 'Zurigo',
// 'Tessin', 'Genève') rather than a code, so we map the it/en/de/fr display
// variants back to a Grossregion. Mirrors the partition in
// cantonSeoProse.ts::cantonDistanceBand. Unknown names fall through to null,
// and callers then use the neutral national-level band (no regression).

function normDisplay(s: string): string {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const DISPLAY_TO_REGION: Record<string, Grossregion> = {};
function reg(region: Grossregion, names: string[]): void {
  for (const n of names) DISPLAY_TO_REGION[normDisplay(n)] = region;
}
reg('zurich', ['zurigo', 'zurich', 'zürich']);
reg('mittelland', [
  'berna', 'bern', 'berne',
  'friburgo', 'fribourg', 'freiburg',
  'soletta', 'solothurn', 'soleure',
  'neuchâtel', 'neuchatel', 'neuenburg',
  'giura', 'jura',
]);
reg('nordwest', [
  // Bare half-canton-group display forms (BL+BS both Nordwest) — without these
  // the localized group name "Basilea"/"Basel"/"Bâle" missed the table and the
  // prose/FAQ salary band silently fell back to the national median while the
  // page tiles used Nordwest (intra-page inconsistency). See PR #2085 review.
  'basilea', 'basel', 'bâle', 'bale',
  'basilea città', 'basilea citta', 'basilea-città', 'basel-stadt', 'basel stadt', 'bâle-ville', 'bale-ville',
  'basilea campagna', 'basilea-campagna', 'basel-landschaft', 'basel landschaft', 'bâle-campagne', 'bale-campagne',
  'argovia', 'aargau', 'argovie',
]);
reg('ostschweiz', [
  'glarona', 'glarus', 'glaris',
  'sciaffusa', 'schaffhausen', 'schaffhouse',
  // Bare half-canton-group display forms (AI+AR both Ostschweiz) — 'appenzello'
  // (IT) was present but 'appenzell' (EN/DE/FR group display) was not, so those
  // locale pages fell back to the national median in the prose/FAQ band while
  // tiles used Ostschweiz. Twin of the BASILEA fix. See PR #2095 review.
  'appenzell',
  'appenzello esterno', 'appenzell ausserrhoden', 'appenzell a.rh.', 'appenzell rhodes-extérieures', 'appenzello',
  'appenzello interno', 'appenzell innerrhoden', 'appenzell i.rh.',
  'san gallo', 'st. gallen', 'st.gallen', 'sankt gallen', 'saint-gall', 'saint gall',
  'grigioni', 'graubünden', 'graubunden', 'grisons', 'grischun',
  'turgovia', 'thurgau', 'thurgovie',
]);
reg('zentral', [
  'lucerna', 'luzern', 'lucerne',
  'uri',
  'svitto', 'schwyz', 'schwytz',
  'obvaldo', 'obwalden', 'obwald',
  'nidvaldo', 'nidwalden', 'nidwald',
  'zugo', 'zug', 'zoug',
]);
reg('lemanique', [
  'vaud', 'waadt',
  'vallese', 'wallis', 'valais',
  'ginevra', 'geneva', 'genf', 'genève', 'geneve',
]);
reg('ticino', ['ticino', 'tessin']);

/** Resolve a localized canton display name to its Grossregion (or null). */
export function grossregionFromDisplay(cantonDisplay: string): Grossregion | null {
  return DISPLAY_TO_REGION[normDisplay(cantonDisplay)] || null;
}

/**
 * Salary factor for a localized canton display name, relative to Ticino.
 * Unknown names fall back to the national factor so prose anchored to the
 * national-average band is unchanged.
 */
export function cantonSalaryFactorFromDisplay(cantonDisplay: string): number {
  const region = grossregionFromDisplay(cantonDisplay);
  if (!region) return NATIONAL_MEDIAN_MONTHLY / TICINO_MEDIAN_MONTHLY;
  return GROSSREGION_MEDIAN_MONTHLY[region] / TICINO_MEDIAN_MONTHLY;
}

export interface CantonSalaryBand {
  grossLow: number;
  grossHigh: number;
  netSingleLow: number;
  netSingleHigh: number;
  netCoupleLow: number;
  netCoupleHigh: number;
}

const round5000 = (n: number) => Math.round(n / 5000) * 5000;
const round100 = (n: number) => Math.round(n / 100) * 100;

// ── Per-canton withholding-tax precision (ESTV-sourced, build/SEO side) ─────
// TypeScript twin of data/swiss-canton-tax-burden.json — inlined as literals
// for the same config-graph reason as the salary index above (this module is
// imported transitively by vite.config.ts; JSON imports aren't reliably
// transformed at config-eval time). tests/swiss-canton-salary-parity.test.ts
// asserts this table equals the JSON byte-for-byte.

export const TAX_BRACKETS: readonly number[] = [30000, 60000, 100000, 150000, 250000];

export const TAX_BURDEN_PCT_BY_CANTON: Record<string, number[]> = {
  AG: [2.81, 8.72, 13.0, 16.77, 22.08],
  AI: [3.87, 7.57, 10.35, 13.22, 16.88],
  AR: [5.48, 10.47, 14.43, 18.05, 22.9],
  BE: [6.98, 12.96, 16.64, 20.65, 26.58],
  BL: [3.82, 11.09, 16.89, 21.91, 28.07],
  BS: [0.3, 10.02, 14.77, 18.37, 22.93],
  FR: [4.37, 11.82, 16.48, 20.58, 26.92],
  GE: [2.14, 11.06, 17.35, 21.99, 28.0],
  GL: [4.31, 9.1, 12.76, 15.98, 21.05],
  GR: [1.29, 8.1, 12.97, 16.86, 21.84],
  JU: [4.26, 10.49, 15.7, 20.36, 26.15],
  LU: [4.01, 9.73, 12.81, 15.6, 20.14],
  NE: [4.78, 13.67, 18.21, 22.43, 28.35],
  NW: [4.08, 8.67, 11.62, 14.45, 18.26],
  OW: [5.16, 9.47, 11.51, 13.68, 17.19],
  SG: [4.6, 10.55, 15.25, 19.19, 24.09],
  SH: [3.46, 8.26, 12.32, 15.9, 21.06],
  SO: [4.58, 11.76, 16.05, 19.78, 24.97],
  SZ: [1.83, 6.47, 9.55, 12.39, 16.3],
  TG: [3.47, 9.55, 13.21, 16.55, 21.41],
  TI: [3.19, 9.26, 14.7, 19.25, 25.0],
  UR: [4.55, 8.97, 11.52, 13.93, 17.66],
  VD: [0.72, 11.89, 17.0, 21.53, 28.33],
  VS: [0.74, 9.7, 14.95, 20.63, 26.95],
  ZG: [0.91, 3.12, 5.63, 8.96, 13.81],
  ZH: [3.85, 7.95, 12.12, 16.26, 22.79],
};

/** National-average curve (mean across all 26 sourced cantons per bracket). */
const TAX_NATIONAL_CURVE: number[] = TAX_BRACKETS.map((_, i) => {
  const codes = Object.keys(TAX_BURDEN_PCT_BY_CANTON);
  return codes.reduce((sum, c) => sum + TAX_BURDEN_PCT_BY_CANTON[c][i], 0) / codes.length;
});

function interpolateTaxCurve(curve: number[], gross: number): number {
  const last = TAX_BRACKETS.length - 1;
  if (gross <= TAX_BRACKETS[0]) return curve[0];
  if (gross >= TAX_BRACKETS[last]) return curve[last];
  for (let i = 0; i < last; i++) {
    const x0 = TAX_BRACKETS[i];
    const x1 = TAX_BRACKETS[i + 1];
    if (gross >= x0 && gross <= x1) {
      const t = (gross - x0) / (x1 - x0);
      return curve[i] + t * (curve[i + 1] - curve[i]);
    }
  }
  return curve[last];
}

/** Flat AVS/AI/APG/AC/LPP social-charge rate; mirrors CH_SOCIAL_RATE in SalaryCompare.tsx. */
const CH_SOCIAL_RATE = 0.136;

/** Net monthly pay for an annual gross at a canton code (falls back to the national-average tax curve for an unmapped code). */
function netMonthlyForCode(grossAnnual: number, code: string | null | undefined): number {
  const c = String(code || '').toUpperCase().trim();
  const curve = c && TAX_BURDEN_PCT_BY_CANTON[c] ? TAX_BURDEN_PCT_BY_CANTON[c] : TAX_NATIONAL_CURVE;
  const taxPct = interpolateTaxCurve(curve, grossAnnual);
  return (grossAnnual * (1 - CH_SOCIAL_RATE - taxPct / 100)) / 12;
}

// Display name -> canton code, for the localized SEO prose (which only ever
// has a display string, not a code). Built from the canonical CANTON_DISPLAY
// map so every renderCantonSeoProse caller resolves to the exact real canton
// behind the localized name it already renders. The two half-canton URL
// groups resolve to the same representative code SALARY_STATS_FACTOR_CODE
// already uses (BASILEA -> BS, APPENZELLO -> AR), so the salary-stats headline
// tile and the SEO prose net figures never disagree on which real canton
// stands in for the group.
const DISPLAY_TO_TAX_CODE: Record<string, string> = {};
for (const [code, names] of Object.entries(CANTON_DISPLAY)) {
  const resolved = code === 'BASILEA' ? 'BS' : code === 'APPENZELLO' ? 'AR' : code;
  for (const name of Object.values(names)) {
    DISPLAY_TO_TAX_CODE[normDisplay(name)] = resolved;
  }
}

function taxCodeFromDisplay(cantonDisplay: string): string | null {
  return DISPLAY_TO_TAX_CODE[normDisplay(cantonDisplay)] || null;
}

/**
 * Net-pay band (single + couple) for a canton code at a given gross band,
 * using the real ESTV-sourced per-canton withholding curve. The couple figure
 * keeps the original anchor's family-deduction ratio (CHF 5'800/5'400 low,
 * 7'200/6'600 high) applied to the now canton-accurate single figure — this
 * task sources per-canton *single* withholding only; the family-deduction
 * effect was never canton-specific in the original anchors either.
 */
function netSalaryBandForCode(
  code: string | null,
  grossLow: number,
  grossHigh: number,
): Pick<CantonSalaryBand, 'netSingleLow' | 'netSingleHigh' | 'netCoupleLow' | 'netCoupleHigh'> {
  const netSingleLow = round100(netMonthlyForCode(grossLow, code));
  const netSingleHigh = round100(netMonthlyForCode(grossHigh, code));
  return {
    netSingleLow,
    netSingleHigh,
    netCoupleLow: round100(netSingleLow * (5800 / 5400)),
    netCoupleHigh: round100(netSingleHigh * (7200 / 6600)),
  };
}

/**
 * Typical-professional gross + net salary band for a canton, used by the SEO
 * prose. Gross is anchored to the original national-average figures (CHF
 * 85k–110k) and scaled by the canton's wage level relative to the national
 * average. Net now uses the real ESTV per-canton withholding curve (previously
 * a flat scale of the same national anchor for every canton — see
 * cantonTaxBurdenPct in services/cantonSalary.ts for the SPA-side twin of this
 * fix). An unmapped display name yields the national-average band (no
 * regression).
 */
export function cantonGrossSalaryBand(cantonDisplay: string): CantonSalaryBand {
  const nationalFactor = NATIONAL_MEDIAN_MONTHLY / TICINO_MEDIAN_MONTHLY;
  const scale = cantonSalaryFactorFromDisplay(cantonDisplay) / nationalFactor;
  const grossLow = round5000(85000 * scale);
  const grossHigh = round5000(110000 * scale);
  const code = taxCodeFromDisplay(cantonDisplay);
  return { grossLow, grossHigh, ...netSalaryBandForCode(code, grossLow, grossHigh) };
}

/**
 * Same net-band computation as cantonGrossSalaryBand, parameterized directly
 * by canton code + an already-scaled gross band. Used by
 * salaryStatsChCantonPages.ts, which resolves its own code (via
 * localeFactorCode) and gross band from the same Grossregion median as its
 * headline tile — kept as a separate entry point (rather than forcing that
 * caller through the display-name path) to avoid re-deriving a code it
 * already has, per the half-canton display-resolution note above
 * cantonGrossSalaryBand.
 */
export function cantonNetSalaryBandForCode(
  code: string | null | undefined,
  grossLow: number,
  grossHigh: number,
): Pick<CantonSalaryBand, 'netSingleLow' | 'netSingleHigh' | 'netCoupleLow' | 'netCoupleHigh'> {
  return netSalaryBandForCode(code || null, grossLow, grossHigh);
}

const round1000 = (n: number) => Math.round(n / 1000) * 1000;

export interface CantonFaqSalary {
  /** Lower bound of the overall median annual gross band (CHF). */
  medianLow: number;
  /** Upper bound = the canton's BFS median annual gross (CHF). */
  medianHigh: number;
  it: number;
  finance: number;
  pharma: number;
  retail: number;
}

/**
 * Median annual gross salary band + a few sector reference figures for a
 * canton, used by the canton-hub editorial FAQ. Derived from the BFS
 * Grossregion median (monthly × 12). The sector reference figures are the
 * national snapshot values scaled by the canton's wage level. An unmapped
 * display name (e.g. the national 'Svizzera' page) uses the national median,
 * preserving the previous national figures.
 */
export function cantonFaqMedianAnnual(cantonDisplay: string): CantonFaqSalary {
  const region = grossregionFromDisplay(cantonDisplay);
  const medianMonthly = region ? GROSSREGION_MEDIAN_MONTHLY[region] : NATIONAL_MEDIAN_MONTHLY;
  const medianAnnual = medianMonthly * 12;
  const scale = medianMonthly / NATIONAL_MEDIAN_MONTHLY;
  return {
    medianLow: round1000(medianAnnual * 0.93),
    medianHigh: round1000(medianAnnual),
    it: round1000(95000 * scale),
    finance: round1000(110000 * scale),
    pharma: round1000(105000 * scale),
    retail: round1000(55000 * scale),
  };
}
