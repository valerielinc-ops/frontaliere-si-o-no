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
 * Resolve a realistic salary band for a given sector with a hard floor
 * at `TICINO_MIN_ANNUAL_CHF`. Never returns `minValue <= 0`.
 */
export function resolveSalaryBand(sector: string | undefined | null): SalaryBand {
  const key = normaliseSectorKey(sector);
  const band = key && SECTOR_MEDIAN_SALARY_CHF[key] ? SECTOR_MEDIAN_SALARY_CHF[key] : DEFAULT_SALARY_BAND;
  const min = Math.max(band.minValue, TICINO_MIN_ANNUAL_CHF);
  const max = Math.max(band.maxValue, min + 1);
  return { minValue: min, maxValue: max, currency: 'CHF' };
}
