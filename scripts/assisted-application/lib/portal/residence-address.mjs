/**
 * Conservative, deterministic normalisation of a candidate's residence.
 *
 * This is geographic address data, not a nationality or immigration-status
 * inference. A CAP is filled only from an explicit CV CAP or from the local
 * locality/province directory. Ambiguous localities remain empty so the
 * candidate is still asked. The directory is generated from GeoNames' Italy
 * postal-code export; it is deliberately not a network lookup at application
 * time, which would send the candidate's address to a third party.
 */

import { createRequire } from 'node:module';
import { nationalityOf } from '../../../../functions/src/lib/permitStatus.js';

const require = createRequire(import.meta.url);
const ITALY_POSTAL_DIRECTORY = require('../../data/italy-postal-codes.json');

const compact = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function fold(value) {
  return compact(value, 300)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

function key(value) {
  return fold(value).replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return fold(value).match(/[a-z0-9]+\.?/g) || [];
}

function localityEquivalent(input, directoryName) {
  const left = tokens(input);
  const right = tokens(directoryName);
  if (left.length !== right.length || left.length === 0) return false;
  return left.every((token, index) => {
    const candidate = token.endsWith('.') ? token.slice(0, -1) : token;
    const known = right[index];
    return candidate === known || (token.endsWith('.') && candidate.length > 0 && known.startsWith(candidate));
  });
}

function removeKnownCountry(value) {
  return compact(value)
    .replace(/(?:,|\s[-–—]\s)\s*(?:italia|italy|italie|italien|svizzera|switzerland|suisse|schweiz)\s*$/i, '')
    .trim();
}

function provinceFrom(value) {
  const text = compact(value);
  return text.match(/\(\s*([A-Za-z]{2})\s*\)\s*$/)?.[1]?.toUpperCase()
    || text.match(/(?:,|[-–—])\s*([A-Za-z]{2})\s*$/)?.[1]?.toUpperCase()
    || '';
}

function cityWithoutProvince(value) {
  return removeKnownCountry(compact(value)
    .replace(/\s*(?:\(|\[)\s*[A-Za-z]{2}\s*(?:\)|\])\s*$/, '')
    .replace(/(?:,|[-–—])\s*[A-Za-z]{2}\s*$/, ''));
}

const entries = (Array.isArray(ITALY_POSTAL_DIRECTORY.entries) ? ITALY_POSTAL_DIRECTORY.entries : [])
  .map(([name, province, postalCode]) => ({ name: String(name), province: String(province).toUpperCase(), postalCode: String(postalCode) }))
  .filter((entry) => entry.name && /^[A-Z]{2}$/.test(entry.province) && /^\d{5}$/.test(entry.postalCode));
const SWISS_CANTONS = new Set(['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH']);
const POSTAL_CACHE = new Map();

/** Return one CAP, or '' when the locality is not uniquely resolvable. */
export function resolveItalianPostalCode(city, province = '') {
  const cityText = cityWithoutProvince(city);
  const provinceCode = String(province || '').toUpperCase().trim();
  const cacheKey = `${provinceCode}|${key(cityText)}`;
  if (POSTAL_CACHE.has(cacheKey)) return POSTAL_CACHE.get(cacheKey);
  if (!cityText) return '';
  const scoped = entries.filter((entry) => !provinceCode || entry.province === provinceCode);
  const exact = scoped.filter((entry) => key(entry.name) === key(cityText));
  const matches = exact.length ? exact : scoped.filter((entry) => localityEquivalent(cityText, entry.name));
  const codes = new Set(matches.map((entry) => entry.postalCode));
  const result = codes.size === 1 ? [...codes][0] : '';
  POSTAL_CACHE.set(cacheKey, result);
  return result;
}

function explicitCountry(value) {
  const text = fold(value);
  if (/^(?:it|italia|italy|italie|italien)$/.test(text)) return 'Italia';
  if (/^(?:ch|svizzera|switzerland|suisse|schweiz)$/.test(text)) return 'Svizzera';
  if (/^(?:de|germania|germany|allemagne|deutschland)$/.test(text)) return 'Germania';
  if (/^(?:fr|francia|france)$/.test(text)) return 'Francia';
  return '';
}

function explicitPostalCode(cvText, city, province) {
  const lines = String(cvText || '').split(/\r?\n/)
    .filter((line) => /\b(?:residen\w*|domicil\w*|indirizzo\s+(?:di\s+)?residen\w*|home\s+address|current\s+address|adresse\s+(?:de\s+)?(?:r[eé]sidence|residence)|wohn(?:sitz|adresse)\w*)\b/i.test(line))
    .filter((line) => !/\b(?:employer|company|azienda|arbeitgeber|entreprise|soci[ée]t[ée]|work(?:place|\s+(?:location|address|country|city|town))|job\s+(?:location|address|city|town)|office|headquarters|sede|datore\s+di\s+lavoro)\b/i.test(line));
  const codes = [...new Set(lines.flatMap((line) => line.match(/\b\d{5}\b/g) || []))];
  if (codes.length !== 1) return '';
  const known = resolveItalianPostalCode(city, province);
  return !known || known === codes[0] ? codes[0] : '';
}

/**
 * Resolve address fields while preserving the candidate's wording. The
 * returned country is intentionally limited to explicit country names and
 * unambiguous Italian/Swiss locality signals.
 */
export function resolveResidenceAddress(rawAddress = {}, location = '', cvText = '') {
  const address = rawAddress && typeof rawAddress === 'object' ? rawAddress : {};
  const rawCity = compact(address.city) || compact(location);
  const province = provinceFrom(address.city) || provinceFrom(location);
  const explicit = explicitCountry(address.country) || explicitCountry(rawCity) || explicitCountry(location);
  const city = cityWithoutProvince(rawCity);
  const knownItalianPostal = resolveItalianPostalCode(city, province);
  const statedPostal = compact(address.postalCode, 20);
  const postalCode = knownItalianPostal
    || explicitPostalCode(cvText, city, province)
    || statedPostal;
  const country = (knownItalianPostal ? 'Italia' : '')
    || explicit
    || (SWISS_CANTONS.has(province) && /^\d{4}$/.test(statedPostal) ? 'Svizzera' : '');
  return {
    street: compact(address.street),
    postalCode,
    city: compact(address.city) || city,
    country,
  };
}

export function enrichProfileResidenceAddress(profile = {}, cvText = '') {
  return {
    ...profile,
    address: resolveResidenceAddress(profile.address, profile.location, cvText),
  };
}

export function residenceCountryCode(value) {
  const text = fold(value);
  const catalogueCode = nationalityOf(text)?.code;
  if (catalogueCode) return catalogueCode;
  if (/^(?:it|italia|italy|italie|italien)$/.test(text)) return 'IT';
  if (/^(?:ch|svizzera|switzerland|suisse|schweiz)$/.test(text)) return 'CH';
  if (/^(?:de|germania|germany|allemagne|deutschland)$/.test(text)) return 'DE';
  if (/^(?:fr|francia|france)$/.test(text)) return 'FR';
  return '';
}

export function addressQuestionAnswer(candidate, topic) {
  // The normal browser path supplies candidateForForm(), where the residence
  // is under identity.address. Keep the planner safe for older/raw callers as
  // well: draft data historically kept the same address under profile.address.
  // Merge rather than choose one wholesale so a partially enriched identity
  // does not hide an explicit profile value.
  const identity = candidate?.identity || {};
  const profile = candidate?.profile || {};
  const rawAddress = { ...(profile.address || {}) };
  for (const [key, value] of Object.entries(identity.address || {})) {
    // An enriched identity can be partial: an empty field must not erase the
    // corresponding explicit value retained in the legacy profile.
    if (value !== null && value !== undefined && String(value).trim()) rawAddress[key] = value;
  }
  const address = resolveResidenceAddress(rawAddress, identity.location || profile.location);
  if (topic === 'address' || topic === 'address_street') return address.street;
  if (topic === 'address_house_number') {
    const marked = address.street.match(/\b(?:n[°ºo]?|no\.?|numero|numéro|civico|house\s*(?:number|no)|street\s*(?:number|no))\s*([0-9]{1,5}[A-Za-z]?)/i)?.[1];
    return marked || address.street.match(/\b([0-9]{1,5}[A-Za-z]?)\b/)?.[1] || '';
  }
  if (topic === 'residence_postal_code') return address.postalCode;
  if (topic === 'residence_city') return address.city || compact(identity.location || profile.location);
  if (topic === 'residence_country') return address.country;
  return '';
}
