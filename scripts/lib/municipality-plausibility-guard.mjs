#!/usr/bin/env node
/**
 * municipality-plausibility-guard.mjs — shared range-plausibility check for
 * the hand-maintained border-municipality dataset builders (issue #4886,
 * hardening follow-up of PR #4878; distribution check added issue #4922).
 *
 * `Number.isFinite()` alone (the only check `build-french-border-municipalities.mjs`
 * / `build-fiscal-municipalities.mjs` ran before this) lets a transcription
 * typo in the hand-maintained source `.ts` literal through silently — e.g.
 * `distanceKm: 200` instead of `20`, or a population off by a decade would
 * sort the commune into the wrong above/below-floor tier (and, where
 * `canton` drives the fiscal regime, the wrong regime) with nothing
 * catching it before commit. Throws loud instead of dropping the row
 * silently: a range violation is a data bug that needs a human, not a
 * commune that quietly vanishes from the dataset.
 *
 * Bounds are deliberately generous — a plausibility floor/ceiling, not the
 * MIN_POPULATION/MAX_DISTANCE_KM business floor each builder already
 * applies separately to pick above-floor vs below-floor.
 */

export const MIN_PLAUSIBLE_DISTANCE_KM = 0;
export const MAX_PLAUSIBLE_DISTANCE_KM = 100;
// Was 50 until issue #4922: data/municipalities.ts's real (ISTAT D7B2024)
// smallest comune is Cervatto (VC), population 47 — a verified genuine
// figure, not a typo. Lowered to 40 (small margin below the real minimum
// observed across every border dataset this guard protects: DE min 92, AT
// min 97, LI min 488, FR min 5032) so it still rejects the actual failure
// mode (0, negative, single/double-digit transcription slips) without
// false-positiving on the smallest real Italian comuni.
export const MIN_PLAUSIBLE_POPULATION = 40;
export const MAX_PLAUSIBLE_POPULATION = 500000;

/**
 * Throws if `m.distanceKm` / `m.population` are finite but outside the
 * plausible range. Non-finite values are left to the caller's own
 * `Number.isFinite()` filter — not this guard's job.
 */
export function assertPlausibleMunicipality(m, { sourceLabel } = {}) {
  const prefix = sourceLabel ? `[${sourceLabel}] ` : '';
  if (
    Number.isFinite(m.distanceKm) &&
    (m.distanceKm < MIN_PLAUSIBLE_DISTANCE_KM || m.distanceKm > MAX_PLAUSIBLE_DISTANCE_KM)
  ) {
    throw new Error(
      `${prefix}implausible distanceKm=${m.distanceKm} for "${m.name}" ` +
        `(expected ${MIN_PLAUSIBLE_DISTANCE_KM}-${MAX_PLAUSIBLE_DISTANCE_KM} km) — ` +
        'check the source data for a transcription error.',
    );
  }
  if (
    Number.isFinite(m.population) &&
    (m.population < MIN_PLAUSIBLE_POPULATION || m.population > MAX_PLAUSIBLE_POPULATION)
  ) {
    throw new Error(
      `${prefix}implausible population=${m.population} for "${m.name}" ` +
        `(expected ${MIN_PLAUSIBLE_POPULATION}-${MAX_PLAUSIBLE_POPULATION}) — ` +
        'check the source data for a transcription error.',
    );
  }
}

// Default share threshold for assertPlausibleDistribution(): the issue
// (#4922) that motivated it found a real placeholder (population: 2000)
// repeated across 80% of a 518-row dataset — a value that dominates the
// distribution this way is never real per-row data, it's an unreplaced
// default. 25% (midpoint of the issue's suggested 20-30% band) is loose
// enough that a real, unremarkable mode (e.g. a common rent-band figure
// shared by a genuine cluster of comuni) does not false-positive, while
// still catching a placeholder-scale repeat before it reaches production.
export const DEFAULT_MAX_VALUE_SHARE = 0.25;

/**
 * Throws if any single value of `field` across `municipalities` covers more
 * than `maxShare` of the rows — the signature of an unreplaced placeholder
 * default (e.g. `population: 2000` on 417/518 rows, issue #4922) rather
 * than real per-row data. Silently returns for arrays too small to judge a
 * distribution meaningfully (`< minSampleSize`, default 20) — a handful of
 * genuinely-identical rows in a small dataset is not evidence of anything.
 *
 * Does not replace assertPlausibleMunicipality(): that catches an
 * out-of-range single value, this catches an in-range value that is
 * suspiciously the same across too many rows.
 *
 * @param {Array<Record<string, unknown>>} municipalities
 * @param {{ field: string, maxShare?: number, sourceLabel?: string, minSampleSize?: number }} options
 */
export function assertPlausibleDistribution(
  municipalities,
  { field, maxShare = DEFAULT_MAX_VALUE_SHARE, sourceLabel, minSampleSize = 20 } = {},
) {
  if (!field) {
    throw new Error('assertPlausibleDistribution: `field` option is required.');
  }
  if (!Array.isArray(municipalities) || municipalities.length < minSampleSize) {
    return;
  }
  const prefix = sourceLabel ? `[${sourceLabel}] ` : '';
  const total = municipalities.length;
  const counts = new Map();
  for (const m of municipalities) {
    const value = m[field];
    if (value === undefined || value === null || Number.isNaN(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  for (const [value, count] of counts) {
    const share = count / total;
    if (share > maxShare) {
      throw new Error(
        `${prefix}implausible distribution: ${field}=${JSON.stringify(value)} repeats in ` +
          `${count}/${total} rows (${(share * 100).toFixed(1)}% of the dataset, over the ` +
          `${(maxShare * 100).toFixed(0)}% plausibility threshold) — this looks like an ` +
          'unreplaced placeholder default, not real per-row data. Check the source for rows ' +
          'still carrying a fallback value.',
      );
    }
  }
}
