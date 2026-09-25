/**
 * cantonDisplay.ts — single source of truth for localized canton display names.
 *
 * Consolidates the per-plugin `CANTON_DISPLAY` maps that had been copy-pasted
 * across jobMarketSnapshotChCantonPages, weeklyEmployersChCantonPages and the
 * job editorial landing (CLAUDE.md rule #6: a constant duplicated across ≥2
 * files must live in ONE shared module). Keyed by the URL canton key (BFS code,
 * or the half-canton URL groups APPENZELLO = AI+AR, BASILEA = BL+BS).
 */

export type CantonDisplayLocale = 'it' | 'en' | 'de' | 'fr';

export const CANTON_DISPLAY: Record<string, Record<CantonDisplayLocale, string>> = {
  AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' },
  // Half-canton URL groups (2026-05-10 merge): AI+AR -> APPENZELLO, BL+BS -> BASILEA.
  APPENZELLO: { it: 'Appenzello', en: 'Appenzell', de: 'Appenzell', fr: 'Appenzell' },
  BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' },
  BASILEA: { it: 'Basilea', en: 'Basel', de: 'Basel', fr: 'Bâle' },
  FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' },
  GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' },
  GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' },
  GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' },
  JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' },
  LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' },
  NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' },
  NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' },
  OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' },
  SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' },
  SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' },
  SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' },
  SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' },
  TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' },
  TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' },
  UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' },
  VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' },
  VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' },
  ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' },
  ZH: { it: 'Zurigo', en: 'Zürich', de: 'Zürich', fr: 'Zurich' },
};

/** Localized canton name with IT fallback, then the raw code. */
export function getCantonDisplayName(code: string, locale: CantonDisplayLocale): string {
  return CANTON_DISPLAY[code]?.[locale] ?? CANTON_DISPLAY[code]?.it ?? code;
}
