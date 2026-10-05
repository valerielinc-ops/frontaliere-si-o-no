/**
 * Localized display names of the 24 canton URL groups (22 cantons + the
 * half-canton groups APPENZELLO = AI+AR and BASILEA = BL+BS), keyed by the
 * URL group code used everywhere else (`canton-url-slugs.json`, the canton
 * section core, the Worker).
 *
 * ONE table for the site and the corpus. It used to live only in
 * `build-plugins/shared/cantonDisplay.ts`, which the engine may not import
 * (`tests/packages-articles-confinement.test.ts`): the canton article
 * sections need the same names in pages the CORPUS renders (landing, archive,
 * topic hubs, RSS channel), so the data moved here and `cantonDisplay.ts`
 * re-exports it. A second copy on this side would be the AGENTS.md #6 drift.
 *
 * Pure data, no imports: loads unchanged under Vite, plain `node` and the
 * corpus repo after the engine mirror.
 *
 * @typedef {'it' | 'en' | 'de' | 'fr'} CantonDisplayLocale
 */

/** @type {Readonly<Record<string, Readonly<Record<CantonDisplayLocale, string>>>>} */
export const CANTON_DISPLAY_NAMES = {
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
