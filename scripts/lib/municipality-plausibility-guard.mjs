#!/usr/bin/env node
/**
 * municipality-plausibility-guard.mjs — shared range-plausibility check for
 * the hand-maintained border-municipality dataset builders (issue #4886,
 * hardening follow-up of PR #4878).
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
export const MIN_PLAUSIBLE_POPULATION = 50;
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
