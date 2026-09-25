/**
 * Realistic Ticino annual-salary defaults per sector, in CHF/YEAR.
 *
 * Used as fallback for `JobPosting.baseSalary` when the source job data
 * lacks explicit salary information. Google Rich Results treats empty /
 * zero salary as a quality issue and an obvious placeholder (e.g. 0 or
 * 1) can cause the posting to be rejected from JobPosting SERPs.
 *
 * Figures are rough Ticino medians (2025) — not legal advice. They are
 * intentionally conservative so they cannot overstate a role's pay.
 *
 * CLAUDE.md rule #3: every JobPosting must have a `baseSalary` with
 * `minValue > 0` and `maxValue >= minValue`.
 */

import {
  cantonSalaryFactor,
  cantonSectorFloor,
  normalizeSalaryCantonCode,
} from './cantonSalaryIndex';

export interface SalaryBand {
  /** Annual minimum in CHF (integer, > 0). */
  readonly minValue: number;
  /** Annual maximum in CHF (integer, >= minValue). */
  readonly maxValue: number;
  /** ISO 4217 currency code. Always `'CHF'` in this project. */
  readonly currency: 'CHF';
}

/**
 * Absolute floor for any annual salary fallback — roughly the Ticino
 * minimum wage (CHF 19.75/h × 40h × 52w ≈ 41,080).
 */
export const TICINO_MIN_ANNUAL_CHF = 41080;

/**
 * Canonical Ticino median annual salaries, keyed by normalised sector
 * slug (lowercase, hyphenated). When a sector is not listed the
 * `default` band is used.
 */
export const SECTOR_MEDIAN_SALARY_CHF: Record<string, SalaryBand> = {
  // Healthcare / LAMal-funded roles
  'sanita': { minValue: 60000, maxValue: 95000, currency: 'CHF' },
  'healthcare': { minValue: 60000, maxValue: 95000, currency: 'CHF' },
  'nursing': { minValue: 65000, maxValue: 90000, currency: 'CHF' },
  'infermieristica': { minValue: 65000, maxValue: 90000, currency: 'CHF' },

  // Banking / finance (Lugano hub)
  'banca': { minValue: 75000, maxValue: 130000, currency: 'CHF' },
  'banking': { minValue: 75000, maxValue: 130000, currency: 'CHF' },
  'finanza': { minValue: 70000, maxValue: 120000, currency: 'CHF' },
  'finance': { minValue: 70000, maxValue: 120000, currency: 'CHF' },
  'assicurazione': { minValue: 65000, maxValue: 110000, currency: 'CHF' },
  'insurance': { minValue: 65000, maxValue: 110000, currency: 'CHF' },

  // Tech / IT
  'informatica': { minValue: 75000, maxValue: 120000, currency: 'CHF' },
  'it': { minValue: 75000, maxValue: 120000, currency: 'CHF' },
  'software': { minValue: 80000, maxValue: 130000, currency: 'CHF' },
  'tech': { minValue: 75000, maxValue: 120000, currency: 'CHF' },
  'ingegneria': { minValue: 75000, maxValue: 115000, currency: 'CHF' },
  'engineering': { minValue: 75000, maxValue: 115000, currency: 'CHF' },

  // Manufacturing / logistics / trades
  'industria': { minValue: 55000, maxValue: 85000, currency: 'CHF' },
  'manufacturing': { minValue: 55000, maxValue: 85000, currency: 'CHF' },
  'logistica': { minValue: 50000, maxValue: 75000, currency: 'CHF' },
  'logistics': { minValue: 50000, maxValue: 75000, currency: 'CHF' },
  'edilizia': { minValue: 55000, maxValue: 80000, currency: 'CHF' },
  'construction': { minValue: 55000, maxValue: 80000, currency: 'CHF' },

  // Retail / hospitality
  'vendita': { minValue: 45000, maxValue: 65000, currency: 'CHF' },
  'retail': { minValue: 45000, maxValue: 65000, currency: 'CHF' },
  'ristorazione': { minValue: 45000, maxValue: 65000, currency: 'CHF' },
  'hospitality': { minValue: 45000, maxValue: 65000, currency: 'CHF' },
  'turismo': { minValue: 45000, maxValue: 70000, currency: 'CHF' },
  'tourism': { minValue: 45000, maxValue: 70000, currency: 'CHF' },

  // Admin / office / HR
  'amministrazione': { minValue: 55000, maxValue: 80000, currency: 'CHF' },
  'admin': { minValue: 55000, maxValue: 80000, currency: 'CHF' },
  'risorse-umane': { minValue: 60000, maxValue: 90000, currency: 'CHF' },
  'hr': { minValue: 60000, maxValue: 90000, currency: 'CHF' },
  'marketing': { minValue: 55000, maxValue: 90000, currency: 'CHF' },
  'comunicazione': { minValue: 55000, maxValue: 85000, currency: 'CHF' },
  'communication': { minValue: 55000, maxValue: 85000, currency: 'CHF' },

  // Education / research
  'formazione': { minValue: 60000, maxValue: 95000, currency: 'CHF' },
  'education': { minValue: 60000, maxValue: 95000, currency: 'CHF' },
  'ricerca': { minValue: 65000, maxValue: 100000, currency: 'CHF' },
  'research': { minValue: 65000, maxValue: 100000, currency: 'CHF' },

  // Public sector / NGO
  'pubblico': { minValue: 60000, maxValue: 95000, currency: 'CHF' },
  'public': { minValue: 60000, maxValue: 95000, currency: 'CHF' },

  // Legal
  'legale': { minValue: 70000, maxValue: 120000, currency: 'CHF' },
  'legal': { minValue: 70000, maxValue: 120000, currency: 'CHF' },
};

/**
 * Map a normalised sector slug (the keys of `SECTOR_MEDIAN_SALARY_CHF`) to the
 * canonical GAV sector name used as a key in `NATIONAL_SECTOR_GAV_FLOOR_ANNUAL`
 * (`Construction` / `Hospitality`) — the only two sectors that carry a national
 * GAV minimum-wage floor. Every other slug is absent here, so it resolves to
 * `''`, which `cantonSectorFloor` treats as "no GAV floor" (gav = 0) → the
 * statutory / universal floor only, i.e. the legacy behaviour for those sectors.
 *
 * Mirrors `CATEGORY_TO_SECTOR` + the GAV floor table in
 * scripts/lib/salary-estimation.mjs, so the `.ts` build fallback and the `.mjs`
 * estimation pipeline floor Edilizia/Ristorazione (Construction/Hospitality)
 * identically for non-TI cantons.
 */
const SLUG_TO_GAV_SECTOR: Record<string, string> = {
  edilizia: 'Construction',
  construction: 'Construction',
  ristorazione: 'Hospitality',
  hospitality: 'Hospitality',
};

/**
 * Neutral fallback band for unclassified roles. Conservative — roughly
 * matches a Ticino entry-level service role.
 */
export const DEFAULT_SALARY_BAND: SalaryBand = {
  minValue: 55000,
  maxValue: 85000,
  currency: 'CHF',
};

/**
 * Normalise an arbitrary sector / category string to the lookup-key
 * format used in `SECTOR_MEDIAN_SALARY_CHF`.
 */
export function normaliseSectorKey(sector: string | undefined | null): string {
  if (!sector) return '';
  return String(sector)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a realistic salary band for a given sector, optionally scaled to a
 * Swiss canton. Never returns `minValue <= 0`.
 *
 * The base bands are Ticino medians. For Ticino (or when no canton is given)
 * the result is byte-identical to the legacy behaviour: floored at
 * `TICINO_MIN_ANNUAL_CHF`. For other cantons the band is scaled by the
 * official BFS wage factor (grossregionMedian / ticinoMedian) and floored at
 * the national GAV sector floor (Construction / Hospitality), the cantonal
 * statutory minimum wage, or the universal sanity floor — whichever is highest
 * (`cantonSectorFloor`), mirroring the `.mjs` estimation pipeline.
 */
export function resolveSalaryBand(
  sector: string | undefined | null,
  canton?: string | undefined | null,
): SalaryBand {
  const key = normaliseSectorKey(sector);
  const band = key && SECTOR_MEDIAN_SALARY_CHF[key] ? SECTOR_MEDIAN_SALARY_CHF[key] : DEFAULT_SALARY_BAND;
  const code = canton ? normalizeSalaryCantonCode(canton) : 'TI';

  if (code === 'TI') {
    const min = Math.max(band.minValue, TICINO_MIN_ANNUAL_CHF);
    const max = Math.max(band.maxValue, min + 1);
    return { minValue: min, maxValue: max, currency: 'CHF' };
  }

  const factor = cantonSalaryFactor(code);
  // Floor at max(national GAV sector floor for Construction/Hospitality,
  // cantonal statutory minimum, universal sanity floor) — mirrors the .mjs
  // getCantonSectorFloor path so an Edilizia/Ristorazione job in a non-TI
  // canton can never fall below its GAV floor in the build fallback.
  const floor = cantonSectorFloor(SLUG_TO_GAV_SECTOR[key] || '', code);
  const min = Math.max(Math.round((band.minValue * factor) / 100) * 100, floor);
  const max = Math.max(Math.round((band.maxValue * factor) / 100) * 100, min + 1);
  return { minValue: min, maxValue: max, currency: 'CHF' };
}
