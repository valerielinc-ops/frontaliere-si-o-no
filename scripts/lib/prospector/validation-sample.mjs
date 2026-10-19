/**
 * Deterministic daily validation samples.
 *
 * The sample is a cyclic, evenly spaced walk over the exact production
 * population. Replaying the same company/population on the same UTC day picks
 * the same rows; advancing the day rotates the starting point so a fixed
 * sample size does not inspect the same positions forever.
 */

export const VALIDATION_SAMPLE_ALGORITHM_VERSION = 'utc-cyclic-strata-v1';

function utcDayNumber(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function vacancyIdentity(vacancy, index) {
  return String(vacancy?.url || vacancy?.sourceUrl || vacancy?.id || `row:${index}`);
}

/**
 * Select a replayable, rotating sample from the exact publishable output.
 * Populations at or below the sample size are measured as a census.
 *
 * @param {any[]} vacancies
 * @param {{ companyKey?: string, sampleSize?: number, date?: Date|string|number }} [options]
 * @returns {{ algorithmVersion: string, day: string, populationCount: number, sampleCount: number,
 *   selected: Array<{ vacancy: any, index: number, stratum: number, id: string }> }}
 */
export function selectValidationSample(vacancies = [], options = {}) {
  const populationCount = Array.isArray(vacancies) ? vacancies.length : 0;
  const sampleSize = Math.max(0, Math.floor(Number(options.sampleSize ?? 4) || 0));
  const date = options.date instanceof Date ? options.date : new Date(options.date ?? Date.now());
  const day = date.toISOString().slice(0, 10);
  const sampleCount = Math.min(populationCount, sampleSize);
  if (sampleCount === 0) {
    return {
      algorithmVersion: VALIDATION_SAMPLE_ALGORITHM_VERSION,
      day,
      populationCount,
      sampleCount,
      selected: [],
    };
  }

  const census = populationCount <= sampleCount;
  const start = census
    ? 0
    : (utcDayNumber(date) + stableHash(options.companyKey)) % populationCount;
  const selected = Array.from({ length: sampleCount }, (_, stratum) => {
    const offset = census ? stratum : Math.floor((stratum * populationCount) / sampleCount);
    const index = (start + offset) % populationCount;
    return {
      vacancy: vacancies[index],
      index,
      stratum,
      id: vacancyIdentity(vacancies[index], index),
    };
  });

  return {
    algorithmVersion: VALIDATION_SAMPLE_ALGORITHM_VERSION,
    day,
    populationCount,
    sampleCount,
    selected,
  };
}
