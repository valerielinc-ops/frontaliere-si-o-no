import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };

/**
 * Representative Swiss locations used only when a source omits mandatory
 * address fields. Each tuple is internally coherent: `city`, `postalCode`
 * and `addressRegion` describe the same locality. These are canton-level
 * safe defaults, not employer headquarters and never replace a source-backed
 * address.
 */
export const CANTON_LOCATION_FALLBACK = {
  AG: { city: 'Aarau', postalCode: '5000', addressRegion: 'AG' },
  AI: { city: 'Appenzell', postalCode: '9050', addressRegion: 'AI' },
  AR: { city: 'Herisau', postalCode: '9100', addressRegion: 'AR' },
  BE: { city: 'Bern', postalCode: '3000', addressRegion: 'BE' },
  BL: { city: 'Liestal', postalCode: '4410', addressRegion: 'BL' },
  BS: { city: 'Basel', postalCode: '4000', addressRegion: 'BS' },
  FR: { city: 'Fribourg', postalCode: '1700', addressRegion: 'FR' },
  GE: { city: 'Genève', postalCode: '1200', addressRegion: 'GE' },
  GL: { city: 'Glarus', postalCode: '8750', addressRegion: 'GL' },
  GR: { city: 'Chur', postalCode: '7000', addressRegion: 'GR' },
  JU: { city: 'Delémont', postalCode: '2800', addressRegion: 'JU' },
  LU: { city: 'Luzern', postalCode: '6000', addressRegion: 'LU' },
  NE: { city: 'Neuchâtel', postalCode: '2000', addressRegion: 'NE' },
  NW: { city: 'Stans', postalCode: '6370', addressRegion: 'NW' },
  OW: { city: 'Sarnen', postalCode: '6060', addressRegion: 'OW' },
  SG: { city: 'St. Gallen', postalCode: '9000', addressRegion: 'SG' },
  SH: { city: 'Schaffhausen', postalCode: '8200', addressRegion: 'SH' },
  SO: { city: 'Solothurn', postalCode: '4500', addressRegion: 'SO' },
  SZ: { city: 'Schwyz', postalCode: '6430', addressRegion: 'SZ' },
  TG: { city: 'Frauenfeld', postalCode: '8500', addressRegion: 'TG' },
  TI: { city: 'Lugano', postalCode: '6900', addressRegion: 'TI' },
  UR: { city: 'Altdorf', postalCode: '6460', addressRegion: 'UR' },
  VD: { city: 'Lausanne', postalCode: '1000', addressRegion: 'VD' },
  VS: { city: 'Brig', postalCode: '3900', addressRegion: 'VS' },
  ZG: { city: 'Zug', postalCode: '6300', addressRegion: 'ZG' },
  ZH: { city: 'Zürich', postalCode: '8000', addressRegion: 'ZH' },
};

/**
 * Backwards-compatible canton → postal-code view used by crawlers that only
 * need the scalar fallback. It is derived from the coherent tuples above so
 * the two representations cannot drift.
 */
export const CANTON_POSTAL_FALLBACK = Object.fromEntries(
  Object.entries(CANTON_LOCATION_FALLBACK).map(([canton, location]) => [canton, location.postalCode]),
);

const DEFAULT_CANTON = 'BE';

const normalizeCityKey = (city = '') => String(city || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CITY_POSTAL_FALLBACK = new Map(
  Object.entries(SWISS_POSTAL_CODES).map(([city, postalCode]) => [normalizeCityKey(city), String(postalCode)]),
);

export function getCantonPostalFallback(canton = '') {
  return CANTON_POSTAL_FALLBACK[String(canton || '').toUpperCase()] || '';
}

export function getCantonLocationFallback(canton = '') {
  return CANTON_LOCATION_FALLBACK[String(canton || '').trim().toUpperCase()] || null;
}

export function getDefaultCantonLocationFallback() {
  return CANTON_LOCATION_FALLBACK[DEFAULT_CANTON];
}

export function getCityPostalFallback(city = '') {
  return CITY_POSTAL_FALLBACK.get(normalizeCityKey(city)) || '';
}
