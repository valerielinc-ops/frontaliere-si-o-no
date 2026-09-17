/**
 * Resolve a complete, internally coherent Swiss structured-data address.
 *
 * A missing CAP must not pair the real municipality with a canton capital's
 * CAP. If the municipality's CAP is known, it wins; otherwise the complete
 * canton-capital address is used.
 */

import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };

const CANTON_CAPITALS = Object.freeze({
  AG: { city: 'Aarau', postalCode: '5000' }, AI: { city: 'Appenzell', postalCode: '9050' },
  AR: { city: 'Herisau', postalCode: '9100' }, BE: { city: 'Bern', postalCode: '3001' },
  BL: { city: 'Liestal', postalCode: '4410' }, BS: { city: 'Basel', postalCode: '4001' },
  FR: { city: 'Fribourg', postalCode: '1700' }, GE: { city: 'Genève', postalCode: '1201' },
  GL: { city: 'Glarus', postalCode: '8750' }, GR: { city: 'Chur', postalCode: '7000' },
  JU: { city: 'Delémont', postalCode: '2800' }, LU: { city: 'Luzern', postalCode: '6000' },
  NE: { city: 'Neuchâtel', postalCode: '2000' }, NW: { city: 'Stans', postalCode: '6370' },
  OW: { city: 'Sarnen', postalCode: '6060' }, SG: { city: 'St. Gallen', postalCode: '9000' },
  SH: { city: 'Schaffhausen', postalCode: '8200' }, SO: { city: 'Solothurn', postalCode: '4500' },
  SZ: { city: 'Schwyz', postalCode: '6430' }, TG: { city: 'Frauenfeld', postalCode: '8500' },
  TI: { city: 'Bellinzona', postalCode: '6500' }, UR: { city: 'Altdorf', postalCode: '6460' },
  VD: { city: 'Lausanne', postalCode: '1000' }, VS: { city: 'Sion', postalCode: '1950' },
  ZG: { city: 'Zug', postalCode: '6300' }, ZH: { city: 'Zürich', postalCode: '8001' },
});

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLocationKey(value = '') {
  return normalizeSpace(value)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isSwissPostalCode(value = '') {
  return /^\d{4}$/.test(normalizeSpace(value));
}

const MUNICIPALITY_KEYS_BY_CANTON = new Map(
  Object.entries(MUNICIPALITY_DATA?.cantons || {}).map(([canton, entry]) => [
    canton.toUpperCase(), new Set((entry?.municipalities || []).map(normalizeLocationKey)),
  ]),
);
const POSTAL_CODES_BY_LOCALITY = new Map(
  Object.entries(SWISS_POSTAL_CODES || {}).map(([locality, postalCode]) => [
    normalizeLocationKey(locality), normalizeSpace(postalCode),
  ]),
);
const POSTAL_CODES_BY_CANTON = new Map();
for (const [canton, municipalityKeys] of MUNICIPALITY_KEYS_BY_CANTON) {
  POSTAL_CODES_BY_CANTON.set(canton, new Set([...municipalityKeys]
    .map((locality) => POSTAL_CODES_BY_LOCALITY.get(locality))
    .filter(isSwissPostalCode)));
}

function resolveMunicipalityPostalCode(city, canton) {
  const locality = normalizeLocationKey(String(city || '').split(/[,·]/, 1)[0]);
  const municipalityKeys = MUNICIPALITY_KEYS_BY_CANTON.get(canton);
  if (!locality || !municipalityKeys?.has(locality)) return '';
  const postalCode = POSTAL_CODES_BY_LOCALITY.get(locality) || '';
  return isSwissPostalCode(postalCode) ? postalCode : '';
}

function postalCodeBelongsToAnotherCanton(postalCode, canton) {
  if (!isSwissPostalCode(postalCode)) return false;
  return [...POSTAL_CODES_BY_CANTON.entries()]
    .some(([knownCanton, postalCodes]) => knownCanton !== canton && postalCodes.has(normalizeSpace(postalCode)));
}

/** Return address fields whose city, postalCode, and canton describe one locality. */
export function resolveSwissStructuredAddress({ city = '', canton = '', postalCode = '', streetAddress = '' } = {}) {
  const normalizedCanton = normalizeSpace(canton).toUpperCase();
  const capital = CANTON_CAPITALS[normalizedCanton] || {};
  const sourceCity = normalizeSpace(city);
  const resolvedCity = sourceCity || capital.city || 'Switzerland';
  const municipalityPostalCode = resolveMunicipalityPostalCode(sourceCity, normalizedCanton);
  const sourcePostalCode = normalizeSpace(postalCode);
  const sourcePostalIsCoherent = isSwissPostalCode(sourcePostalCode)
    && !postalCodeBelongsToAnotherCanton(sourcePostalCode, normalizedCanton);

  if (municipalityPostalCode) {
    return { city: resolvedCity, canton: normalizedCanton || 'CH', postalCode: municipalityPostalCode, streetAddress: normalizeSpace(streetAddress) || resolvedCity };
  }
  if (sourcePostalIsCoherent) {
    return { city: resolvedCity, canton: normalizedCanton || 'CH', postalCode: sourcePostalCode, streetAddress: normalizeSpace(streetAddress) || resolvedCity };
  }
  if (capital.city && capital.postalCode) {
    return { city: capital.city, canton: normalizedCanton || 'CH', postalCode: capital.postalCode, streetAddress: capital.city };
  }
  return { city: resolvedCity, canton: normalizedCanton || 'CH', postalCode: '0000', streetAddress: normalizeSpace(streetAddress) || resolvedCity };
}
