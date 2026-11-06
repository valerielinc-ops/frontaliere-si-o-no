/**
 * Deterministic daily validation samples.
 *
 * The sample is a cyclic, evenly spaced walk over the exact production
 * population. Replaying the same company/population on the same UTC day picks
 * the same rows; advancing the day rotates the starting point so a fixed
 * sample size does not inspect the same positions forever.
 */

export const VALIDATION_SAMPLE_ALGORITHM_VERSION = 'utc-cyclic-strata-anomaly-v2';

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

/** Increase evidence where inventory size or recent anomalies justify it. */
export function adaptiveValidationSampleSize({ baseSampleSize = 3, populationCount = 0, candidate = null, maxSampleSize = 8 } = {}) {
  const base = Math.max(1, Math.floor(Number(baseSampleSize) || 1));
  const maximum = Math.max(base, Math.floor(Number(maxSampleSize) || 8));
  const population = Math.max(0, Math.floor(Number(populationCount) || 0));
  if (population === 0) return 0;
  let desired = Math.min(maximum, base);
  if (population >= 25) desired = Math.max(desired, Math.min(maximum, 5));
  if (population >= 100) desired = maximum;
  const latest = Array.isArray(candidate?.validationHistory) ? candidate.validationHistory.at(-1) : null;
  if ((Array.isArray(candidate?.validationAnomalyIds) && candidate.validationAnomalyIds.length)
    || latest?.verdict === 'weak'
    || latest?.runtimeSnapshotComplete === false) {
    desired = maximum;
  }
  return Math.min(population, desired);
}

/**
 * Select a replayable, rotating sample from the exact publishable output.
 * Populations at or below the sample size are measured as a census.
 *
 * @param {any[]} vacancies
 * @param {{ companyKey?: string, sampleSize?: number, anomalyIds?: string[], date?: Date|string|number }} [options]
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
  const selectedIndices = [];
  const selectedIndexSet = new Set();
  const indexByIdentity = new Map();
  for (let index = 0; index < populationCount; index++) {
    const id = vacancyIdentity(vacancies[index], index);
    if (!indexByIdentity.has(id)) indexByIdentity.set(id, index);
  }
  for (const id of [...new Set((options.anomalyIds || []).map((value) => String(value || '')).filter(Boolean))]) {
    const index = indexByIdentity.get(id);
    if (index === undefined || selectedIndexSet.has(index)) continue;
    selectedIndices.push(index);
    selectedIndexSet.add(index);
    if (selectedIndices.length >= sampleCount) break;
  }

  for (let stratum = 0; selectedIndices.length < sampleCount && stratum < sampleCount * 2; stratum++) {
    const offset = census ? stratum : Math.floor((stratum * populationCount) / sampleCount);
    const index = (start + offset) % populationCount;
    if (selectedIndexSet.has(index)) continue;
    selectedIndices.push(index);
    selectedIndexSet.add(index);
  }
  for (let offset = 0; selectedIndices.length < sampleCount && offset < populationCount; offset++) {
    const index = (start + offset) % populationCount;
    if (selectedIndexSet.has(index)) continue;
    selectedIndices.push(index);
    selectedIndexSet.add(index);
  }
  const selected = selectedIndices.map((index, stratum) => ({
    vacancy: vacancies[index],
    index,
    stratum,
    id: vacancyIdentity(vacancies[index], index),
  }));

  return {
    algorithmVersion: VALIDATION_SAMPLE_ALGORITHM_VERSION,
    day,
    populationCount,
    sampleCount,
    selected,
  };
}
