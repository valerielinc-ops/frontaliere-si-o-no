import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };
import { resolveFallbackAddress } from '../../build-plugins/shared/companyHqAddresses.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

const CANTONS = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU',
  'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);

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

function structuredFallback(city, canton, companySlug = '') {
  const fallback = resolveFallbackAddress(companySlug, city, canton);
  return {
    city: fallback.addressLocality,
    canton: fallback.addressRegion,
    postalCode: fallback.postalCode,
    streetAddress: fallback.streetAddress,
  };
}

/** Resolve a complete address without pairing a city with another locality's CAP. */
export function resolveSwissStructuredAddress({
  city = '',
  canton = '',
  postalCode = '',
  streetAddress = '',
  companySlug = '',
} = {}) {
  const cantonCode = resolveCanton(canton, city) || 'TI';
  const municipality = resolveMunicipality(city, cantonCode);
  const knownPostal = municipality ? verifiedPostalForCity(municipality) : '';

  if (municipality && knownPostal) {
    const sourcePostal = String(postalCode || '').trim();
    const sourceStreet = String(streetAddress || '').trim();
    const fallback = structuredFallback(municipality, cantonCode, companySlug);
    const streetIsLocality = normalize(sourceStreet) === normalize(municipality);
    const postalIsCoherent = !sourcePostal || sourcePostalMatchesCity(municipality, sourcePostal);
    if (!postalIsCoherent) {
      return fallback;
    }
    if (!sourceStreet || streetIsLocality) return fallback;
    return {
      city: municipality,
      canton: cantonCode,
      postalCode: knownPostal,
      streetAddress: sourceStreet,
    };
  }

  return structuredFallback(city, cantonCode, companySlug);
}
