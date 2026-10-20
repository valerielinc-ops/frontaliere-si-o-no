/**
 * cantonDisplay.ts — single source of truth for localized canton display names.
 *
 * Consolidates the per-plugin `CANTON_DISPLAY` maps that had been copy-pasted
 * across jobMarketSnapshotChCantonPages, weeklyEmployersChCantonPages and the
 * job editorial landing (CLAUDE.md rule #6: a constant duplicated across ≥2
 * files must live in ONE shared module). Keyed by the URL canton key (BFS code,
 * or the half-canton URL groups APPENZELLO = AI+AR, BASILEA = BL+BS).
 */

import { CANTON_DISPLAY_NAMES } from '../../packages/articles/engine/shared/cantonDisplayNames.mjs';

export type CantonDisplayLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * The table itself lives in the articles engine
 * (`packages/articles/engine/shared/cantonDisplayNames.mjs`): the corpus
 * renders the canton article sections with the same names and the engine may
 * not import `build-plugins/**`. Re-exported here so every caller keeps its
 * import and there is still exactly one copy of the data.
 */
export const CANTON_DISPLAY: Record<string, Record<CantonDisplayLocale, string>> =
  CANTON_DISPLAY_NAMES as Record<string, Record<CantonDisplayLocale, string>>;

/** Localized canton name with IT fallback, then the raw code. */
export function getCantonDisplayName(code: string, locale: CantonDisplayLocale): string {
  return CANTON_DISPLAY[code]?.[locale] ?? CANTON_DISPLAY[code]?.it ?? code;
}
