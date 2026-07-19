/**
 * cantonSalary.ts — SPA-side per-canton salary scaling.
 *
 * The SalaryCompare stats page holds national-CH gross figures (SALARY_DATA).
 * To show a single canton, the national figure is scaled by the canton's wage
 * level relative to the national median, using the same official BFS index
 * (data/swiss-canton-salary-index.json) that drives the pipeline estimator and
 * the SEO prose. Reading the JSON keeps this in lock-step with that single
 * source of truth (no duplicated constants).
 */
import index from '@/data/swiss-canton-salary-index.json';
import taxBurden from '@/data/swiss-canton-tax-burden.json';
import { DEFAULT_TECH_PARAMS } from '@/constants';

/** Sentinel for the national (all-Switzerland) view — scale 1.0. */
export const NATIONAL_CANTON = 'CH';

const CANTON_TO_REGION = index.cantonToGrossregion as Record<string, string>;
const REGION_MEDIAN = index.grossregionMedianMonthly as Record<string, number>;
const NATIONAL_MEDIAN = index.nationalMedianMonthly as number;

/** BFS canton codes that have a salary mapping, in a stable order. */
export const SALARY_CANTON_CODES: readonly string[] = Object.freeze(
  Object.keys(CANTON_TO_REGION).sort(),
);

/**
 * Scale a national-CH gross salary to a canton: grossregionMedian /
 * nationalMedian. The national sentinel (or any unknown code) returns 1.0, so
 * the default view is unchanged.
 */
export function cantonGrossScale(code: string | null | undefined): number {
  const c = String(code || '').toUpperCase().trim();
  if (!c || c === NATIONAL_CANTON) return 1;
  const region = CANTON_TO_REGION[c];
  const median = REGION_MEDIAN[region];
  return region && median && NATIONAL_MEDIAN ? median / NATIONAL_MEDIAN : 1;
}

// ── Per-canton withholding-tax precision (ESTV-sourced) ─────────────────────

const TAX_BRACKETS = taxBurden.incomeBracketsCHF as number[];
const TAX_BURDEN_PCT_BY_CANTON = taxBurden.totalTaxBurdenPctByCanton as Record<
  string,
  number[]
>;

/**
 * National-average curve (mean across all 26 sourced cantons at each
 * bracket), used for the "CH" sentinel and any unmapped code — keeps the
 * default view a single curve while still being ESTV-sourced rather than
 * a guess.
 */
const NATIONAL_CURVE: number[] = TAX_BRACKETS.map((_, i) => {
  const codes = Object.keys(TAX_BURDEN_PCT_BY_CANTON);
  return (
    codes.reduce((sum, c) => sum + TAX_BURDEN_PCT_BY_CANTON[c][i], 0) / codes.length
  );
});

/** Linear interpolation between bracket points; flat-clamped past the ends. */
function interpolateCurve(curve: number[], gross: number): number {
  const clampedGross = Math.max(0, gross);
  const last = TAX_BRACKETS.length - 1;
  if (clampedGross <= TAX_BRACKETS[0]) return curve[0];
  if (clampedGross >= TAX_BRACKETS[last]) return curve[last];
  for (let i = 0; i < last; i++) {
    const x0 = TAX_BRACKETS[i];
    const x1 = TAX_BRACKETS[i + 1];
    if (clampedGross >= x0 && clampedGross <= x1) {
      const t = (clampedGross - x0) / (x1 - x0);
      return curve[i] + t * (curve[i + 1] - curve[i]);
    }
  }
  return curve[last];
}

/**
 * Total CH tax burden (%, excludes social security) for a gross income at a
 * given canton, interpolated across the 5 ESTV-sourced reference points
 * (canton capital, single/no children/no religion, tax year 2024). The
 * national sentinel (or any unmapped code) falls back to NATIONAL_CURVE.
 */
export function cantonTaxBurdenPct(gross: number, code?: string | null): number {
  const c = String(code || '').toUpperCase().trim();
  const curve =
    c && c !== NATIONAL_CANTON && TAX_BURDEN_PCT_BY_CANTON[c]
      ? TAX_BURDEN_PCT_BY_CANTON[c]
      : NATIONAL_CURVE;
  return interpolateCurve(curve, gross);
}

// ── "Same job in another canton" net estimate (issue #4471) ──────────────────

/**
 * Flat CH social-security rate for a resident (AVS/AI/IPG + AD + LAINF + IGM +
 * LPP mid-band), reused from the calculator's default technical parameters so
 * the comparison never drifts from the main engine's contribution assumptions.
 */
const SOCIAL_RATE =
  DEFAULT_TECH_PARAMS.avsRate +
  DEFAULT_TECH_PARAMS.acRate +
  DEFAULT_TECH_PARAMS.laaRate +
  DEFAULT_TECH_PARAMS.ijmRate +
  DEFAULT_TECH_PARAMS.lppRate35_44;

export interface CantonNetEstimate {
  /** Target canton ISO code (e.g. 'ZH'). */
  canton: string;
  /** Same-role gross scaled to the target canton's wage level (CHF/year). */
  grossAnnualCHF: number;
  /** Estimated net for a RESIDENT taxed in that canton (CHF/month). */
  netMonthlyCHF: number;
}

/**
 * Estimate the monthly net a resident would take home for the SAME role in
 * another canton, starting from the user's current Ticino gross salary.
 *
 * Two official signals combine (both already sourced in this module):
 *   1. Wage level — the gross is rescaled from Ticino's wage level to the target
 *      canton's (BFS grossregion medians, `cantonGrossScale`). "Same job" ⇒ the
 *      pay a comparable role commands in that region.
 *   2. Tax burden — the residents' total cantonal+municipal income-tax burden at
 *      that gross (`cantonTaxBurdenPct`, ESTV), minus flat social security.
 *
 * Returns `null` for a non-positive/unusable gross so callers hide the row
 * rather than render a fabricated figure.
 */
export function estimateCantonNetMonthly(
  userGrossAnnualCHF: number,
  toCanton: string,
  fromCanton: string = 'TI',
): CantonNetEstimate | null {
  const gross = Number(userGrossAnnualCHF);
  if (!Number.isFinite(gross) || gross <= 0) return null;
  const c = String(toCanton || '').toUpperCase().trim();
  if (!c) return null;

  const fromScale = cantonGrossScale(fromCanton);
  const toScale = cantonGrossScale(c);
  if (!fromScale) return null;
  const grossAnnual = gross * (toScale / fromScale);

  const socialCHF = grossAnnual * SOCIAL_RATE;
  const taxCHF = grossAnnual * (cantonTaxBurdenPct(grossAnnual, c) / 100);
  const netAnnual = grossAnnual - socialCHF - taxCHF;

  return {
    canton: c,
    grossAnnualCHF: Math.round(grossAnnual),
    netMonthlyCHF: Math.round(netAnnual / 12),
  };
}

/**
 * Default set of high-interest comparison cantons for the calculator's
 * "same job in other cantons" section — the metros frontaliere audiences most
 * often weigh against Ticino. `TI` itself is excluded by the caller.
 */
export const CANTON_COMPARISON_DEFAULTS: readonly string[] = Object.freeze([
  'ZH',
  'GE',
  'ZG',
  'BS',
  'VD',
]);
