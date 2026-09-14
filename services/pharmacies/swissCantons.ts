/**
 * Stable presentation metadata for the 26 Swiss cantons.
 *
 * This is deliberately not a source registry: a canton can be represented in
 * the coverage hub before a duty source has been verified. Keeping the
 * geography separate from `pharmacy-sources-registry.json` lets the UI say
 * "not connected yet" without inventing an official URL or a duty schedule.
 */

export type SwissCantonLocale = 'it' | 'en' | 'de' | 'fr';

export interface SwissCanton {
  readonly code: string;
  readonly key: string;
  readonly names: Readonly<Record<SwissCantonLocale, string>>;
}

export const SWISS_CANTONS: readonly SwissCanton[] = Object.freeze([
  { code: 'AG', key: 'aargau', names: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' } },
  { code: 'AI', key: 'appenzell-innerrhoden', names: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' } },
  { code: 'AR', key: 'appenzell-ausserrhoden', names: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' } },
  { code: 'BE', key: 'bern', names: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' } },
  { code: 'BL', key: 'basel-landschaft', names: { it: 'Basilea Campagna', en: 'Basel-Landschaft', de: 'Basel-Landschaft', fr: 'Bâle-Campagne' } },
  { code: 'BS', key: 'basel-stadt', names: { it: 'Basilea Città', en: 'Basel-Stadt', de: 'Basel-Stadt', fr: 'Bâle-Ville' } },
  { code: 'FR', key: 'fribourg', names: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' } },
  { code: 'GE', key: 'geneva', names: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' } },
  { code: 'GL', key: 'glarus', names: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' } },
  { code: 'GR', key: 'graubunden', names: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' } },
  { code: 'JU', key: 'jura', names: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' } },
  { code: 'LU', key: 'lucerne', names: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' } },
  { code: 'NE', key: 'neuchatel', names: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' } },
  { code: 'NW', key: 'nidwalden', names: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' } },
  { code: 'OW', key: 'obwalden', names: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' } },
  { code: 'SG', key: 'st-gallen', names: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' } },
  { code: 'SH', key: 'schaffhausen', names: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' } },
  { code: 'SO', key: 'solothurn', names: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' } },
  { code: 'SZ', key: 'schwyz', names: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' } },
  { code: 'TG', key: 'thurgau', names: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' } },
  { code: 'TI', key: 'ticino', names: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' } },
  { code: 'UR', key: 'uri', names: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' } },
  { code: 'VD', key: 'vaud', names: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' } },
  { code: 'VS', key: 'valais', names: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' } },
  { code: 'ZG', key: 'zug', names: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' } },
  { code: 'ZH', key: 'zurich', names: { it: 'Zurigo', en: 'Zurich', de: 'Zürich', fr: 'Zurich' } },
] as const);
