import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import { CANTON_CAPITAL_ADDRESSES, resolveFallbackAddress } from '../../build-plugins/shared/companyHqAddresses.ts';
import { POSTAL_BY_CITY } from '../../build-plugins/shared/postalCodes.ts';
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
const POSTALS_BY_CITY = new Map(Object.entries(POSTAL_BY_CITY)
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
  if (CANTON_CAPITAL_ADDRESSES[canton]) return { ...CANTON_CAPITAL_ADDRESSES[canton] };
  const fallback = resolveFallbackAddress(undefined, '', canton);
  if (fallback.addressRegion === canton && /^\d{4}$/.test(fallback.postalCode)) return { ...fallback };
  return { ...(EXTRA_CAPITALS[canton] || EXTRA_CAPITALS.AI) };
}

/** Resolve a complete address without pairing a city with another locality's CAP. */
export function resolveSwissStructuredAddress({ city = '', canton = '', postalCode = '', streetAddress = '' } = {}) {
  const cantonCode = resolveCanton(canton, city) || 'TI';
  const municipality = resolveMunicipality(city, cantonCode);
  const knownPostal = municipality ? verifiedPostalForCity(municipality) : '';

  if (municipality && knownPostal) {
    const sourcePostal = String(postalCode || '').trim();
    const postalIsCoherent = !sourcePostal || sourcePostalMatchesCity(municipality, sourcePostal);
    const fallback = resolveFallbackAddress(undefined, municipality, cantonCode);
    const fallbackIsCoherent = fallback.addressLocality === municipality && fallback.postalCode === knownPostal;
    return {
      city: municipality,
      canton: cantonCode,
      postalCode: knownPostal,
      streetAddress: (postalIsCoherent ? String(streetAddress || '').trim() : '')
        || (fallbackIsCoherent ? fallback.streetAddress : municipality),
    };
  }

  const fallback = cantonFallback(cantonCode);
  return {
    city: fallback.addressLocality,
    canton: fallback.addressRegion,
    postalCode: fallback.postalCode,
    streetAddress: String(streetAddress || '').trim() || fallback.streetAddress,
  };
}
