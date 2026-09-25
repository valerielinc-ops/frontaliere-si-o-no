/**
 * Weather city cluster — frontaliere SEO targets. CH-side first per
 * /plan-design-review D3 (cluster geografico ordering).
 */

export interface WeatherCity {
  id: string;
  name: string;
  country: 'CH' | 'IT';
  lat: number;
  lng: number;
  /** Slug per locale, used by the build plugin and router. */
  slug: { it: string; en: string; de: string; fr: string };
  /** Province / canton for breadcrumb context. */
  region: { it: string; en: string; de: string; fr: string };
}

export const WEATHER_CITIES: readonly WeatherCity[] = Object.freeze([
  // CH-side cluster (frontaliere-relevant) — ordered first
  {
    id: 'lugano',
    name: 'Lugano',
    country: 'CH',
    lat: 46.0037,
    lng: 8.9511,
    slug: { it: 'lugano', en: 'lugano', de: 'lugano', fr: 'lugano' },
    region: { it: 'Canton Ticino', en: 'Canton Ticino', de: 'Kanton Tessin', fr: 'Canton Tessin' },
  },
  {
    id: 'bellinzona',
    name: 'Bellinzona',
    country: 'CH',
    lat: 46.1953,
    lng: 9.0227,
    slug: { it: 'bellinzona', en: 'bellinzona', de: 'bellenz', fr: 'bellinzone' },
    region: { it: 'Canton Ticino', en: 'Canton Ticino', de: 'Kanton Tessin', fr: 'Canton Tessin' },
  },
  {
    id: 'mendrisio',
    name: 'Mendrisio',
    country: 'CH',
    lat: 45.8693,
    lng: 8.9842,
    slug: { it: 'mendrisio', en: 'mendrisio', de: 'mendrisio', fr: 'mendrisio' },
    region: { it: 'Canton Ticino', en: 'Canton Ticino', de: 'Kanton Tessin', fr: 'Canton Tessin' },
  },
  {
    id: 'locarno',
    name: 'Locarno',
    country: 'CH',
    lat: 46.1670,
    lng: 8.7943,
    slug: { it: 'locarno', en: 'locarno', de: 'locarno', fr: 'locarno' },
    region: { it: 'Canton Ticino', en: 'Canton Ticino', de: 'Kanton Tessin', fr: 'Canton Tessin' },
  },
  {
    id: 'chiasso',
    name: 'Chiasso',
    country: 'CH',
    lat: 45.8334,
    lng: 9.0307,
    slug: { it: 'chiasso', en: 'chiasso', de: 'chiasso', fr: 'chiasso' },
    region: { it: 'Canton Ticino', en: 'Canton Ticino', de: 'Kanton Tessin', fr: 'Canton Tessin' },
  },
  // IT-side cluster (frontaliere residence cities)
  {
    id: 'como',
    name: 'Como',
    country: 'IT',
    lat: 45.8081,
    lng: 9.0852,
    slug: { it: 'como', en: 'como', de: 'como', fr: 'come' },
    region: { it: 'Provincia di Como', en: 'Como Province', de: 'Provinz Como', fr: 'Province de Côme' },
  },
  {
    id: 'varese',
    name: 'Varese',
    country: 'IT',
    lat: 45.8206,
    lng: 8.8251,
    slug: { it: 'varese', en: 'varese', de: 'varese', fr: 'varese' },
    region: { it: 'Provincia di Varese', en: 'Varese Province', de: 'Provinz Varese', fr: 'Province de Varèse' },
  },
  {
    id: 'lecco',
    name: 'Lecco',
    country: 'IT',
    lat: 45.8566,
    lng: 9.3970,
    slug: { it: 'lecco', en: 'lecco', de: 'lecco', fr: 'lecco' },
    region: { it: 'Provincia di Lecco', en: 'Lecco Province', de: 'Provinz Lecco', fr: 'Province de Lecco' },
  },
] as const);

export function findCityById(id: string): WeatherCity | undefined {
  return WEATHER_CITIES.find((c) => c.id === id);
}

export function findCityBySlug(slug: string, locale: 'it' | 'en' | 'de' | 'fr'): WeatherCity | undefined {
  return WEATHER_CITIES.find((c) => c.slug[locale] === slug);
}
