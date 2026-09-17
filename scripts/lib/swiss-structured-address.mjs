import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };
import { inferAnyCanton } from './target-swiss-locations.mjs';

const CANTONS = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU',
  'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);

const EXTRA_CAPITALS = Object.freeze({
  AI: { streetAddress: 'Hauptgasse 2', postalCode: '9050', addressLocality: 'Appenzell', addressRegion: 'AI' },
  AR: { streetAddress: 'Poststrasse 6', postalCode: '9100', addressLocality: 'Herisau', addressRegion: 'AR' },
  BL: { streetAddress: 'Rathausstrasse 36', postalCode: '4410', addressLocality: 'Liestal', addressRegion: 'BL' },
  GL: { streetAddress: 'Rathausplatz 1', postalCode: '8750', addressLocality: 'Glarus', addressRegion: 'GL' },
  JU: { streetAddress: 'Rue de la Préfecture 12', postalCode: '2800', addressLocality: 'Delémont', addressRegion: 'JU' },
  NW: { streetAddress: 'Stansstaderstrasse 54', postalCode: '6370', addressLocality: 'Stans', addressRegion: 'NW' },
  OW: { streetAddress: 'Brünigstrasse 160', postalCode: '6060', addressLocality: 'Sarnen', addressRegion: 'OW' },
  SZ: { streetAddress: 'Herrengasse 23', postalCode: '6430', addressLocality: 'Schwyz', addressRegion: 'SZ' },
  UR: { streetAddress: 'Rathausplatz 2', postalCode: '6460', addressLocality: 'Altdorf', addressRegion: 'UR' },
});

// Keep the fallback tuple self-contained and Node-loadable: this helper is
// imported by the standalone Capri .mjs crawler, before Vite/tsx exists.
const CANTON_CAPITAL_ADDRESSES = Object.freeze({
  TI: { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  ZH: { streetAddress: 'Bahnhofstrasse 1', postalCode: '8001', addressLocality: 'Zürich', addressRegion: 'ZH' },
  BE: { streetAddress: 'Bundesplatz 3', postalCode: '3011', addressLocality: 'Bern', addressRegion: 'BE' },
  GE: { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  VD: { streetAddress: 'Place de la Palud 2', postalCode: '1003', addressLocality: 'Lausanne', addressRegion: 'VD' },
  BS: { streetAddress: 'Marktplatz 9', postalCode: '4001', addressLocality: 'Basel', addressRegion: 'BS' },
  SO: { streetAddress: 'Hauptgasse 72', postalCode: '4500', addressLocality: 'Solothurn', addressRegion: 'SO' },
  VS: { streetAddress: 'Rue du Grand-Pont 12', postalCode: '1950', addressLocality: 'Sion', addressRegion: 'VS' },
  LU: { streetAddress: 'Kornmarkt 3', postalCode: '6004', addressLocality: 'Luzern', addressRegion: 'LU' },
  SG: { streetAddress: 'Gallusstrasse 14', postalCode: '9000', addressLocality: 'St. Gallen', addressRegion: 'SG' },
  ZG: { streetAddress: 'Postplatz 1', postalCode: '6300', addressLocality: 'Zug', addressRegion: 'ZG' },
  GR: { streetAddress: 'Poststrasse 33', postalCode: '7000', addressLocality: 'Chur', addressRegion: 'GR' },
  AG: { streetAddress: 'Rathausgasse 1', postalCode: '5000', addressLocality: 'Aarau', addressRegion: 'AG' },
  TG: { streetAddress: 'Rathausplatz 1', postalCode: '8500', addressLocality: 'Frauenfeld', addressRegion: 'TG' },
  SH: { streetAddress: 'Vordergasse 17', postalCode: '8200', addressLocality: 'Schaffhausen', addressRegion: 'SH' },
  FR: { streetAddress: "Place de l'Hôtel-de-Ville 1", postalCode: '1700', addressLocality: 'Fribourg', addressRegion: 'FR' },
  NE: { streetAddress: "Rue de l'Hôtel-de-Ville 1", postalCode: '2000', addressLocality: 'Neuchâtel', addressRegion: 'NE' },
  ...EXTRA_CAPITALS,
});

// Only use a city-level street when it is a curated tuple for that same
// locality. Unknown municipalities fall back to the complete canton tuple.
const CITY_FALLBACK_STREETS = Object.freeze({
  lugano: 'Piazza Riforma 1',
  mendrisio: 'Via Luigi Benteler 1',
  winterthur: 'Stadthausstrasse 4a',
  landquart: 'Bahnhofstrasse 2',
});

function normalize(value = '') {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanCity(value = '') {
  return String(value || '').replace(/\s*\([A-Z]{2}\)\s*$/i, '')
    .replace(/\s*,\s*(?:Switzerland|Schweiz|Svizzera|Suisse)\s*$/i, '').trim();
}

function buildMunicipalityIndex() {
  const byCanton = new Map();
  const global = new Map();
  for (const [canton, entry] of Object.entries(MUNICIPALITY_DATA.cantons || {})) {
    const scoped = new Map();
    for (const raw of [...(entry?.municipalities || []), ...(entry?.aliases || [])]) {
      const display = cleanCity(raw);
      const key = normalize(display);
      if (!key) continue;
      if (!scoped.has(key)) scoped.set(key, display);
      if (!global.has(key)) global.set(key, new Map());
      global.get(key).set(canton, display);
    }
    byCanton.set(canton, scoped);
  }
  return { byCanton, global };
}

const MUNICIPALITIES = buildMunicipalityIndex();
const POSTALS_BY_CITY = new Map(Object.entries(SWISS_POSTAL_CODES)
  .map(([city, postal]) => [normalize(city), String(postal)]));

function resolveCanton(value, city) {
  const code = normalize(value).toUpperCase();
  if (CANTONS.has(code)) return code;
  return inferAnyCanton(value) || inferAnyCanton(city) || '';
}

function resolveMunicipality(city, canton) {
  const key = normalize(cleanCity(city));
  if (!key) return '';
  const scoped = MUNICIPALITIES.byCanton.get(canton);
  if (scoped?.has(key)) return scoped.get(key);
  const candidates = MUNICIPALITIES.global.get(key);
  return candidates?.size === 1 ? [...candidates.values()][0] : '';
}

function verifiedPostalForCity(city) {
  return POSTALS_BY_CITY.get(normalize(city)) || '';
}

export function sourcePostalMatchesCity(city, postalCode) {
  const postal = String(postalCode || '').trim();
  return /^\d{4}$/.test(postal) && verifiedPostalForCity(city) === postal;
}

function cantonFallback(canton) {
  return { ...(CANTON_CAPITAL_ADDRESSES[canton] || CANTON_CAPITAL_ADDRESSES.TI) };
}

function cityFallback(city, canton, postalCode) {
  const streetAddress = CITY_FALLBACK_STREETS[normalize(city)];
  if (!streetAddress) return null;
  return { city, canton, postalCode, streetAddress };
}

/** Resolve a complete address without pairing a city with another locality's CAP. */
export function resolveSwissStructuredAddress({ city = '', canton = '', postalCode = '', streetAddress = '' } = {}) {
  const cantonCode = resolveCanton(canton, city) || 'TI';
  const municipality = resolveMunicipality(city, cantonCode);
  const knownPostal = municipality ? verifiedPostalForCity(municipality) : '';

  if (municipality && knownPostal) {
    const sourcePostal = String(postalCode || '').trim();
    const sourceStreet = String(streetAddress || '').trim();
    const postalIsCoherent = !sourcePostal || sourcePostalMatchesCity(municipality, sourcePostal);
    const localFallback = cityFallback(municipality, cantonCode, knownPostal);
    if (!postalIsCoherent) return localFallback || cantonFallback(cantonCode);
    return {
      city: municipality,
      canton: cantonCode,
      postalCode: knownPostal,
      streetAddress: sourceStreet || localFallback?.streetAddress || cantonFallback(cantonCode).streetAddress,
    };
  }

  const fallback = cantonFallback(cantonCode);
  return {
    city: fallback.addressLocality,
    canton: fallback.addressRegion,
    postalCode: fallback.postalCode,
    streetAddress: fallback.streetAddress,
  };
}
