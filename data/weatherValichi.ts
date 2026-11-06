/**
 * Frontaliere valichi (border crossings) for the F8 fusion meteo+webcam
 * section. Coords match the existing borderCrossings data set; this file
 * adds weather-specific config (webcam URLs are sourced from the F8
 * borderWaitMapPlugin webcam catalog at build time).
 */

export interface WeatherValico {
  id: string;
  name: string;
  /** localised name, used in headings and breadcrumbs. */
  nameLocalised: { it: string; en: string; de: string; fr: string };
  lat: number;
  lng: number;
  /** Slug used in F8 page URL: /tempi-attesa-frontiera/{slug}/ */
  slug: string;
  /** which alert configs are valico-relevant (dictate the alert banner). */
  alertIds: readonly string[];
}

export const WEATHER_VALICHI: readonly WeatherValico[] = Object.freeze([
  {
    id: 'chiasso',
    name: 'Chiasso-Brogeda',
    nameLocalised: { it: 'Chiasso-Brogeda', en: 'Chiasso-Brogeda', de: 'Chiasso-Brogeda', fr: 'Chiasso-Brogeda' },
    lat: 45.8334, lng: 9.0307,
    slug: 'chiasso-brogeda',
    alertIds: ['nebbia-mendrisio', 'snow-gottardo', 'gelo-confine', 'ghiaccio-strade'],
  },
  {
    id: 'stabio',
    name: 'Stabio',
    nameLocalised: { it: 'Stabio', en: 'Stabio', de: 'Stabio', fr: 'Stabio' },
    lat: 45.8482, lng: 8.9342,
    slug: 'rodero-stabio',
    alertIds: ['nebbia-mendrisio', 'gelo-confine', 'ghiaccio-strade'],
  },
  {
    id: 'gandria',
    name: 'Gandria',
    nameLocalised: { it: 'Gandria', en: 'Gandria', de: 'Gandria', fr: 'Gandria' },
    lat: 46.0167, lng: 9.0167,
    slug: 'oria-gandria',
    alertIds: ['nebbia-mendrisio', 'gelo-confine'],
  },
  {
    id: 'ponte-tresa',
    name: 'Ponte Tresa',
    nameLocalised: { it: 'Ponte Tresa', en: 'Ponte Tresa', de: 'Ponte Tresa', fr: 'Ponte Tresa' },
    lat: 45.9667, lng: 8.8500,
    slug: 'ponte-tresa',
    alertIds: ['gelo-confine', 'ghiaccio-strade'],
  },
  {
    id: 'gaggiolo',
    name: 'Gaggiolo',
    nameLocalised: { it: 'Gaggiolo', en: 'Gaggiolo', de: 'Gaggiolo', fr: 'Gaggiolo' },
    lat: 45.8533, lng: 8.9000,
    slug: 'gaggiolo',
    alertIds: ['nebbia-mendrisio', 'gelo-confine', 'ghiaccio-strade'],
  },
] as const);

export function findValicoById(id: string): WeatherValico | undefined {
  return WEATHER_VALICHI.find((v) => v.id === id);
}
