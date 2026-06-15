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

/**
 * Typical-professional gross + net salary band for a canton, used by the SEO
 * prose. Anchored to the original national-average figures (gross CHF
 * 85k–110k; net CHF 5'400–6'600 single, 5'800–7'200 couple) and scaled by the
 * canton's wage level relative to the national average. An unmapped display
 * name yields exactly the anchor band (no regression).
 */
export function cantonGrossSalaryBand(cantonDisplay: string): CantonSalaryBand {
  const nationalFactor = NATIONAL_MEDIAN_MONTHLY / TICINO_MEDIAN_MONTHLY;
  const scale = cantonSalaryFactorFromDisplay(cantonDisplay) / nationalFactor;
  return {
    grossLow: round5000(85000 * scale),
    grossHigh: round5000(110000 * scale),
    netSingleLow: round100(5400 * scale),
    netSingleHigh: round100(6600 * scale),
    netCoupleLow: round100(5800 * scale),
    netCoupleHigh: round100(7200 * scale),
  };
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
