import {
  inferSwissTargetCanton,
  isCantonRelevant,
  normalizeSwissTargetLocationText,
} from '../target-swiss-locations.mjs';

const SWISS_COUNTRY_LABELS = new Set([
  'ch', 'che', 'schweiz', 'suisse', 'svizzera', 'svizra', 'switzerland',
]);
const FOREIGN_COUNTRY_LABELS = new Set([
  'allemagne', 'argentina', 'australia', 'austria', 'belgien', 'belgique',
  'belgio', 'belgium', 'brasil', 'brazil', 'bulgaria', 'canada', 'china',
  'chine', 'croatia', 'deutschland', 'dinamarca', 'danemark', 'denmark',
  'espagne', 'espana', 'estados unidos', 'etats unis', 'finland', 'finlande',
  'finnland', 'france', 'georgia', 'germania', 'germany', 'giappone', 'grecia', 'greece',
  'griechenland', 'hungary', 'inde', 'india', 'indien', 'irlanda', 'ireland',
  'italia', 'italie', 'italien', 'italy', 'japan', 'japon', 'kanada', 'mexico',
  'new zealand', 'niederlande', 'norway', 'norwegen', 'nouvelle zelande',
  'osterreich', 'paesi bassi', 'pays bas', 'poland', 'pologne', 'polonia',
  'portogallo', 'portugal', 'regno unito', 'rumania', 'romania', 'roumanie',
  'royaume uni', 'russia', 'serbia', 'singapore', 'slovakia', 'slovenia',
  'south africa', 'spagna', 'spanien', 'spain', 'stati uniti', 'sudafrica',
  'sverige', 'sweden', 'taiwan', 'turchia', 'turkey', 'uk', 'ukraine',
  'united arab emirates', 'united kingdom', 'united states', 'usa',
  'vereinigte staaten', 'vereinigtes konigreich',
]);

function hasToken(value, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(value);
}

function hasOnlyExplicitForeignCountry(value) {
  const normalized = normalizeSwissTargetLocationText(value);
  const hasSwiss = [...SWISS_COUNTRY_LABELS].some((label) => hasToken(normalized, label));
  const hasForeign = [...FOREIGN_COUNTRY_LABELS].some((label) => hasToken(normalized, label));
  return hasForeign && !hasSwiss;
}

function locationCodes(value) {
  const raw = String(value || '');
  const uppercase = [...raw.matchAll(/(?:^|[\s(,;/|])([A-Z]{2})(?=$|[\s),;/|])/g)]
    .map((match) => match[1]);
  // Lowercase codes are accepted only in country/canton-shaped positions.
  // Scanning every two-letter lowercase word would misread prose such as
  // "Canton de Vaud" (`de`) as ISO-DE.
  const shaped = [...raw.matchAll(/(?:\(([a-z]{2})\)|(?:^|[\s,;/|])([a-z]{2})(?=\s+\d{3,10}\b|\s*[,;/|)]|$))/gi)]
    .map((match) => match[1] || match[2]);
  return [...new Set([...uppercase, ...shaped].map((code) => code.toUpperCase()))]
    .map((code) => ({ code }));
}

function stripLocationCodes(value, codes = locationCodes(value)) {
  let out = String(value || '');
  for (const { code } of codes) {
    const codePattern = new RegExp(`(?:^|[\\s(,;/|])${code}(?=$|[\\s),;/|])`, 'gi');
    out = out.replace(codePattern, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function explicitCorroboratedCanton(value, codes = locationCodes(value), withoutCodes = stripLocationCodes(value, codes)) {
  for (const code of codes) {
    if (code.code === 'CH') continue;
    if (isCantonRelevant(withoutCodes, code.code, { includeBorderProximity: false })) return code.code;
  }
  return '';
}

function hasUncorroboratedTerminalCountryCode(value, codes, withoutCodes) {
  const raw = String(value || '').trim();
  return codes.some(({ code }) => {
    if (code === 'CH') return false;
    const countryShaped = new RegExp(
      `(?:\\(${code}\\)|(?:^|[,;/|]\\s*)${code}(?=\\s+\\d{3,10}\\b|$)|\\b${code}(?=\\s+\\d{3,10}\\b|$))`,
      'i',
    ).test(raw);
    if (!countryShaped) return false;
    return !isCantonRelevant(withoutCodes, code, { includeBorderProximity: false });
  });
}

function isSwissCountry(value) {
  const country = normalizeSwissTargetLocationText(value);
  return Boolean(country && [...SWISS_COUNTRY_LABELS].some((label) => hasToken(country, label)));
}

function isExplicitlyForeign(value, addressCountry = '') {
  const country = String(addressCountry || '').trim();
  if (country && !isSwissCountry(country)) return true;
  if (hasOnlyExplicitForeignCountry(value)) return true;
  const codes = locationCodes(value);
  const withoutCodes = stripLocationCodes(value, codes);
  return hasUncorroboratedTerminalCountryCode(value, codes, withoutCodes);
}

/**
 * Accept geography only when the crawler extracted a non-empty location and
 * that value identifies a Swiss canton. The location is kept verbatim because
 * it is source evidence; this helper never substitutes an employer HQ or a
 * generic city.
 *
 * @param {unknown} value
 * @param {unknown} [addressCountry]
 * @returns {{ location: string, canton: string, addressCountry?: string }|null}
 */
export function resolveSourceBackedSwissGeography(value, addressCountry = '') {
  const location = String(value || '').replace(/\s+/g, ' ').trim();
  if (!location) return null;
  // Municipality names have international homonyms (e.g. Provence VD). An
  // explicit terminal country segment from the source outranks that fuzzy
  // token match. Multi-location rows that also name Switzerland remain valid.
  if (isExplicitlyForeign(location, addressCountry)) return null;
  const codes = locationCodes(location);
  const withoutCodes = stripLocationCodes(location, codes);
  // A source can publish both a municipality and an explicit canton marker.
  // Prefer the marker only when the remaining text independently corroborates
  // it: this resolves "Brügg BE, Bern" before fuzzy "Brugg" → AG, without
  // treating the legal-form suffix in "Company AG, Zürich" as canton Aargau.
  const canton = explicitCorroboratedCanton(location, codes, withoutCodes) || inferSwissTargetCanton(withoutCodes);
  if (!canton || !isCantonRelevant(withoutCodes, canton, { includeBorderProximity: false })) return null;
  const geography = { location, canton };
  const country = String(addressCountry || '').trim();
  if (country) geography.addressCountry = country;
  return geography;
}

/** @param {any} record */
export function locationEvidenceCandidates(record = {}) {
  const candidates = Array.isArray(record?.locationCandidates) ? [...record.locationCandidates] : [];
  const fallback = {
    location: String(record?.location || '').trim(),
    addressCountry: String(record?.addressCountry || record?.country || '').trim(),
  };
  if (fallback.location || fallback.addressCountry) candidates.push(fallback);
  const seen = new Set();
  return candidates
    .map((candidate) => typeof candidate === 'string'
      ? { location: candidate, addressCountry: '' }
      : {
          ...candidate,
          location: String(candidate?.location || '').trim(),
          addressCountry: String(candidate?.addressCountry || candidate?.country || '').trim(),
        })
    .filter((candidate) => {
      if (!candidate.location && !candidate.addressCountry) return false;
      const key = `${candidate.location}\u0000${candidate.addressCountry}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** @param {{ location?: string, addressCountry?: string, country?: string }[]} candidates */
export function evaluateSourceBackedSwissGeography(candidates = []) {
  let explicitlyForeign = false;
  for (const candidate of candidates) {
    const location = String(candidate?.location || '').trim();
    const country = String(candidate?.addressCountry || candidate?.country || '').trim();
    if (isExplicitlyForeign(location, country)) {
      explicitlyForeign = true;
      continue;
    }
    const geography = resolveSourceBackedSwissGeography(location, country);
    if (geography) return { geography, explicitlyForeign, candidate };
  }
  return { geography: null, explicitlyForeign };
}

export function resolveDetailOrListingSwissGeography(detail = {}, listing = {}) {
  const detailDecision = evaluateSourceBackedSwissGeography(locationEvidenceCandidates(detail));
  if (detailDecision.geography || detailDecision.explicitlyForeign) return detailDecision;
  return evaluateSourceBackedSwissGeography(locationEvidenceCandidates(listing));
}

function structuredText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return structuredText(value[0]);
  if (value && typeof value === 'object') {
    return structuredText(value.name || value['@value'] || value.value || '');
  }
  return '';
}

/**
 * Preserve every schema.org JobPosting location and its country/address
 * evidence. Dedicated crawlers use the same representation as the generic
 * Prospector runtime so a foreign first entry cannot hide a later CH place.
 *
 * @param {unknown} jobLocation
 */
export function schemaJobLocationCandidates(jobLocation) {
  const places = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  const candidates = [];
  for (const place of places) {
    if (!place || typeof place !== 'object') continue;
    const addresses = Array.isArray(place.address) ? place.address : [place.address || place];
    for (const address of addresses) {
      if (!address || typeof address !== 'object') continue;
      const addressLocality = structuredText(address.addressLocality);
      const addressRegion = structuredText(address.addressRegion);
      const addressCountry = structuredText(address.addressCountry);
      const placeName = structuredText(address.name || place.name);
      const location = [addressLocality || placeName, addressRegion].filter(Boolean).join(', ');
      if (!location && !addressCountry) continue;
      candidates.push({
        location,
        addressCountry,
        addressLocality,
        addressRegion,
        postalCode: structuredText(address.postalCode),
        streetAddress: structuredText(address.streetAddress),
      });
    }
  }
  return candidates;
}
