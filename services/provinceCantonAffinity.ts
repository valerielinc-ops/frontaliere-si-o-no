/**
 * Province → Swiss canton commuting affinity.
 *
 * Soft geographic signal only — NEVER a hard filter. Maps an Italian
 * border province (as used in `data/municipalities.ts`) to the canton(s)
 * a resident of that province most plausibly commutes to, based on
 * geographic proximity to the border crossing. Inland provinces with no
 * clear single-canton commute pattern (BG, BS, MB, TN) intentionally map
 * to an empty list rather than a guessed affinity.
 */

import { findMunicipality } from '../data/municipalities';

const PROVINCE_TO_CANTONS: Readonly<Record<string, readonly string[]>> = {
  CO: ['TI'],
  VA: ['TI'],
  VB: ['TI', 'VS'],
  SO: ['GR'],
  BZ: ['GR'],
  AO: ['VS'],
  VC: ['VS'],
};

/** Canton(s) a resident of `province` (2-letter Italian province code) most plausibly commutes to. Empty array = no reliable affinity. */
export function provinceToCantons(province: string | null | undefined): string[] {
  const code = String(province || '').trim().toUpperCase();
  return code ? [...(PROVINCE_TO_CANTONS[code] || [])] : [];
}

/** Canton(s) plausibly reachable from `municipality` (accepts "Name" or "Name (PROVINCE)"), via its province. Empty array if municipality unknown or has no affinity. */
export function municipalityToCantons(municipality: string | null | undefined): string[] {
  if (!municipality) return [];
  const muni = findMunicipality(municipality);
  return muni ? provinceToCantons(muni.province) : [];
}
