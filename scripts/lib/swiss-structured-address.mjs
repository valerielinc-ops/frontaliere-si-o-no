/**
 * Safe structured-data address defaults for Swiss job postings.
 *
 * Crawlers keep the source locality/canton as the location signal, but a
 * missing street or postal code must not remove the JobPosting address fields.
 * The fallback street is deliberately the resolved locality itself: it is a
 * coherent, non-fabricated token until the source exposes a real street.
 */

import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import SWISS_POSTAL_CODES from '../../data/swiss-postal-codes.json' with { type: 'json' };

const CANTON_CAPITALS = {
  AG: { city: 'Aarau', postalCode: '5000' },
  AI: { city: 'Appenzell', postalCode: '9050' },
  AR: { city: 'Herisau', postalCode: '9100' },
  BE: { city: 'Bern', postalCode: '3001' },
  BL: { city: 'Liestal', postalCode: '4410' },
  BS: { city: 'Basel', postalCode: '4001' },
  FR: { city: 'Fribourg', postalCode: '1700' },
  GE: { city: 'Genève', postalCode: '1201' },
  GL: { city: 'Glarus', postalCode: '8750' },
  GR: { city: 'Chur', postalCode: '7000' },
  JU: { city: 'Delémont', postalCode: '2800' },
  LU: { city: 'Luzern', postalCode: '6000' },
  NE: { city: 'Neuchâtel', postalCode: '2000' },
  NW: { city: 'Stans', postalCode: '6370' },
  OW: { city: 'Sarnen', postalCode: '6060' },
  SG: { city: 'St. Gallen', postalCode: '9000' },
  SH: { city: 'Schaffhausen', postalCode: '8200' },
  SO: { city: 'Solothurn', postalCode: '4500' },
  SZ: { city: 'Schwyz', postalCode: '6430' },
  TG: { city: 'Frauenfeld', postalCode: '8500' },
  TI: { city: 'Bellinzona', postalCode: '6500' },
  UR: { city: 'Altdorf', postalCode: '6460' },
  VD: { city: 'Lausanne', postalCode: '1000' },
  VS: { city: 'Sion', postalCode: '1950' },
  ZG: { city: 'Zug', postalCode: '6300' },
  ZH: { city: 'Zürich', postalCode: '8001' },
};

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSwissPostalCode(value = '') {
  return /^\d{4}$/.test(normalizeSpace(value));
}

function normalizeLocationKey(value = '') {
  return normalizeSpace(value).toLowerCase();
}

function firstLocalitySegment(value = '') {
  return normalizeSpace(value).split(/[,·]/, 1)[0];
}

const MUNICIPALITY_KEYS_BY_CANTON = new Map(
  Object.entries(MUNICIPALITY_DATA?.cantons || {}).map(([canton, entry]) => [
    canton.toUpperCase(),
    new Set((entry?.municipalities || []).map(normalizeLocationKey)),
  ]),
);

const POSTAL_CODES_BY_LOCALITY = new Map(
  Object.entries(SWISS_POSTAL_CODES || {}).map(([locality, postalCode]) => [
    normalizeLocationKey(locality),
    normalizeSpace(postalCode),
  ]),
);

function resolveMunicipalityPostalCode(city = '', canton = '') {
  const locality = firstLocalitySegment(city);
  const localityKey = normalizeLocationKey(locality);
  const municipalityKeys = MUNICIPALITY_KEYS_BY_CANTON.get(canton);
  if (!localityKey || !municipalityKeys?.has(localityKey)) return '';
  const postalCode = POSTAL_CODES_BY_LOCALITY.get(localityKey) || '';
  return isSwissPostalCode(postalCode) ? postalCode : '';
}

/**
 * Keep a resolved city/canton and fill only missing address components.
 * `streetAddress: city` is the same safe fallback used by other crawlers in
 * this repository; it avoids inventing a street number while keeping the
 * required structured-data field present and locality-coherent.
 */
export function resolveSwissStructuredAddress({
  city = '',
  canton = '',
  postalCode = '',
  streetAddress = '',
} = {}) {
  const normalizedCanton = normalizeSpace(canton).toUpperCase();
  const capital = CANTON_CAPITALS[normalizedCanton] || {};
  const sourceCity = normalizeSpace(city);
  const resolvedCity = sourceCity || capital.city || 'Switzerland';

  const municipalityPostalCode = resolveMunicipalityPostalCode(sourceCity, normalizedCanton);
  if (!isSwissPostalCode(postalCode) && municipalityPostalCode) {
    return {
      city: resolvedCity,
      canton: normalizedCanton || 'CH',
      postalCode: municipalityPostalCode,
      streetAddress: normalizeSpace(streetAddress) || resolvedCity,
    };
  }

  // A canton-capital postcode cannot safely be paired with a different
  // municipality and the municipality lookup has no CAP, use the complete
  // capital fallback so the structured address remains internally coherent.
  if (!isSwissPostalCode(postalCode) && capital.city && capital.postalCode) {
    return {
      city: capital.city,
      canton: normalizedCanton || 'CH',
      postalCode: capital.postalCode,
      streetAddress: capital.city,
    };
  }

  return {
    city: resolvedCity,
    canton: normalizedCanton || 'CH',
    postalCode: isSwissPostalCode(postalCode) ? normalizeSpace(postalCode) : capital.postalCode || '0000',
    streetAddress: normalizeSpace(streetAddress) || resolvedCity,
  };
}
