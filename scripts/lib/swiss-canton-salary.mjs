/**
 * swiss-canton-salary.mjs — per-canton salary index accessors (pipeline side)
 *
 * Reads the canonical BFS data file data/swiss-canton-salary-index.json and
 * exposes the helpers used by the estimation pipeline
 * (scripts/lib/salary-estimation.mjs) to make salary estimates canton-aware.
 *
 * Methodology (see the JSON _methodology field for the full rationale):
 *   - BFS publishes wage medians only at the 7 Grossregionen level for free.
 *   - Each canton inherits its Grossregion median; the Ticino USTAT sector
 *     structure is scaled by  factor = grossregionMedian / ticinoMedian.
 *   - Ticino factor = 1.0  ->  Ticino estimates stay byte-identical.
 *   - The frontalieri (cross-border) discount applies only to BORDER cantons,
 *     where Permit G commuters actually work. Interior cantons use the full
 *     resident median (factor only, no frontalieri discount).
 *
 * The .ts twin build-plugins/shared/cantonSalaryIndex.ts mirrors the same
 * numbers as inline literals (the Vite config graph cannot safely import JSON
 * at module-eval time). tests/swiss-canton-salary-parity.test.ts locks the two
 * to this JSON so the data can never drift.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

function loadIndex() {
  // Prefer module-relative resolution (real Node ESM). Fall back to the cwd
  // (Vite/vitest, where import.meta.url is not a file: URL and the above
  // throws "URL must be of scheme file"). Pipeline scripts run from the repo
  // root, so the cwd path is reliable there too.
  const candidates = [];
  try {
    candidates.push(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../data/swiss-canton-salary-index.json'),
    );
  } catch {
    /* import.meta.url not a file: URL — use cwd below */
  }
  candidates.push(resolve(process.cwd(), 'data/swiss-canton-salary-index.json'));
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('swiss-canton-salary-index.json not found');
}

const INDEX = loadIndex();

const TI_MEDIAN = Number(INDEX.ticinoMedianMonthly) || 5708;
const CANTON_TO_REGION = INDEX.cantonToGrossregion || {};
const REGION_MEDIAN = INDEX.grossregionMedianMonthly || {};
const BORDER = new Set(INDEX.borderCantons || []);
const STATUTORY_FLOOR = INDEX.statutoryMinWageAnnual || {};
const UNIVERSAL_FLOOR = Number(INDEX.universalFloorAnnual) || 41600;
const SECTOR_GAV_FLOOR = INDEX.nationalSectorGavFloorAnnual || {};

/** Normalise an arbitrary canton input to a 2-letter BFS code; default 'TI'. */
export function normalizeSalaryCantonCode(code) {
  const c = String(code || '').toUpperCase().trim();
  return /^[A-Z]{2}$/.test(c) && CANTON_TO_REGION[c] ? c : 'TI';
}

/**
 * Per-canton wage factor relative to Ticino, derived from the official BFS
 * Grossregion medians. Ticino === 1.0. Unknown cantons fall back to Ticino.
 */
export function getCantonSalaryFactor(code) {
  const c = normalizeSalaryCantonCode(code);
  const region = CANTON_TO_REGION[c];
  const median = Number(REGION_MEDIAN[region]);
  if (!Number.isFinite(median) || !(TI_MEDIAN > 0)) return 1;
  return median / TI_MEDIAN;
}

/** True when the canton has a meaningful cross-border (frontalieri) workforce. */
export function isBorderCanton(code) {
  return BORDER.has(normalizeSalaryCantonCode(code));
}

/**
 * Lower-bound annual salary floor for a sector in a canton:
 *   max( national GAV sector floor (Construction / Hospitality, unscaled),
 *        cantonal statutory minimum wage if any, else the universal sanity floor )
 *
 * Ticino keeps its own richer CCL floor table in salary-estimation.mjs, so this
 * helper is only consulted for non-TI cantons.
 */
export function getCantonSectorFloor(sectorName, code) {
  const c = normalizeSalaryCantonCode(code);
  const gav = Number(SECTOR_GAV_FLOOR[sectorName]) || 0;
  const statutory = Number(STATUTORY_FLOOR[c]) || UNIVERSAL_FLOOR;
  return Math.max(gav, statutory);
}

export {
  TI_MEDIAN as TICINO_MEDIAN_MONTHLY,
  CANTON_TO_REGION as CANTON_TO_GROSSREGION,
  REGION_MEDIAN as GROSSREGION_MEDIAN_MONTHLY,
  UNIVERSAL_FLOOR as UNIVERSAL_FLOOR_ANNUAL,
};
