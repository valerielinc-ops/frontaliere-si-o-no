/**
 * Conservative, deterministic normalisation of a candidate's residence.
 *
 * Address fields are filled only from values stated in the candidate's
 * profile or CV. A locality does not prove its postal code or country; missing
 * address details remain questions for the candidate.
 */

import { createRequire } from 'node:module';
import { nationalityOf } from '../../../../functions/src/lib/permitStatus.js';
import { officialLocalityPostalCode } from '../../../../scripts/lib/swiss-locality-directory.mjs';

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

const LOCALITY_LABEL_RE = /^\s*(?:localit(?:à|a|é|e|y)?\w*|locality|citt[aà]|city|town|ville|lieu|commune|wohn(?:ort|sitz|adresse)\w*|ort)(?=\s|:|-|$)(?:\s+(?:(?:de|of)\s+(?:(?:la|le|les|l[’'])\s+)?|(?:du|des|la|le|in|im|am|von|zu)\s+))?\s*(?::|-)?\s*/i;
const POSTAL_LABEL_RE = /^\s*(?:postcode|post\s*code|postal\s+code|code\s+postal|zip(?:\s+code)?|plz|npa|cap|codice\s+postale)(?=\s|:|-|$)\s*(?::|-)?\s*/i;
const GENERAL_ADDRESS_LABEL_RE = /^\s*(?:domicilio|residen\w*|indirizzo(?:\s+di\s+residen\w*)?|address|residence)(?=\s|:|-|$)\s*(?::|-)?\s*/i;
const STREET_TYPE_RE = /\b(?:via|viale|piazza|piazzale|corso|strada|largo|vicolo|contrada|avenue|rue|chemin|route|place|boulevard|quai|gasse|strasse|straße|weg|platz|allee|street|st\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|[\p{L}]*strasse|[\p{L}]*straße)\b/iu;

function postalCodeDigits(value) {
  const unlabelled = compact(value, 20).replace(POSTAL_LABEL_RE, '').trim();
  return /^\d{4,5}$/.test(unlabelled) ? unlabelled : '';
}

function addressTextVariants(value) {
  const raw = compact(value);
  const labelled = raw.replace(GENERAL_ADDRESS_LABEL_RE, '').replace(LOCALITY_LABEL_RE, '').replace(POSTAL_LABEL_RE, '');
  if (!labelled) return [];
  const countryless = removeKnownCountry(labelled)
    .replace(/\s+(?:italia|italy|italie|italien|svizzera|switzerland|suisse|schweiz)\s*$/i, '')
    .trim();
  const withoutPostal = countryless.replace(/\b\d{4,5}\b/g, ' ').replace(/\s+/g, ' ').trim();
  return [raw, labelled, countryless, cityWithoutProvince(countryless), withoutPostal, cityWithoutProvince(withoutPostal)]
    .map(key)
    .filter(Boolean);
}

function localityOnlyStreet(street, { city, location, postalCode, country, province } = {}) {
  const streetText = compact(street);
  if (POSTAL_LABEL_RE.test(streetText)) return true;
  if (LOCALITY_LABEL_RE.test(streetText)) {
    const localityValue = streetText.replace(LOCALITY_LABEL_RE, '').trim();
    if (!STREET_TYPE_RE.test(localityValue)) return true;
  }
  const numericOnly = compact(street);
  if (/^\d{4,5}$/.test(numericOnly)) {
    const knownPostalCode = compact(postalCode);
    if (!/^\d{4,5}$/.test(knownPostalCode)) return true;
    return numericOnly === knownPostalCode;
  }
  const knownLocalities = new Set([
    ...addressTextVariants(city),
    ...addressTextVariants(location),
    ...addressTextVariants(country),
    ...addressTextVariants(province),
    ...addressTextVariants(postalCode),
  ]);
  if (!knownLocalities.size) return false;
  const streetVariants = addressTextVariants(street);
  if (!streetVariants.length) return true;
  return streetVariants.some((variant) => {
    if (knownLocalities.has(variant)) return true;
    const withoutNumericSuffix = variant.replace(/\s+\d{1,5}[a-z]?$/i, '').trim();
    return withoutNumericSuffix !== variant && knownLocalities.has(withoutNumericSuffix);
  });
}

const entries = (Array.isArray(ITALY_POSTAL_DIRECTORY.entries) ? ITALY_POSTAL_DIRECTORY.entries : [])
  .map(([name, province, postalCode]) => ({ name: String(name), province: String(province).toUpperCase(), postalCode: String(postalCode) }))
  .filter((entry) => entry.name && /^[A-Z]{2}$/.test(entry.province) && /^\d{5}$/.test(entry.postalCode));

/** Return one CAP, or '' when the locality is not uniquely resolvable. */
export function resolveItalianPostalCode(city, province = '') {
  const cityText = cityWithoutProvince(city);
  const provinceCode = String(province || '').toUpperCase().trim();
  if (!cityText) return '';
  const scoped = entries.filter((entry) => !provinceCode || entry.province === provinceCode);
  const exact = scoped.filter((entry) => key(entry.name) === key(cityText));
  const matches = exact.length ? exact : scoped.filter((entry) => localityEquivalent(cityText, entry.name));
  const codes = new Set(matches.map((entry) => entry.postalCode));
  const result = codes.size === 1 ? [...codes][0] : '';
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

function explicitCountryFrom(value) {
  const exact = explicitCountry(value);
  if (exact) return exact;
  const text = fold(value);
  const suffix = /(?:^|\s)(italia|italy|italie|italien|svizzera|switzerland|suisse|schweiz|germania|germany|allemagne|deutschland|francia|france|it|ch|de|fr)$/.exec(text)?.[1];
  return explicitCountry(suffix || '');
}

const CV_SECTION_RE = /\b(?:esperienz\w*|experience|berufserfahrung|work history|education|istruzion\w*|formazione|ausbildung|formation|competenz\w*|qualific\w*|skills|capacita|competenze)\b/i;
const NON_RESIDENCE_RE = /\b(?:employer|company|azienda|arbeitgeber|entreprise|soci[ée]t[ée]|work(?:place|\s+(?:location|address|country|city|town))|job\s+(?:location|address|city|town)|office|headquarters|sede|datore\s+di\s+lavoro|born|geburt|nascit\w*|naissance|birth\s+(?:date|place)|data\s+di\s+nascita)\b/i;

function cvAddressEvidenceLines(cvText) {
  const all = String(cvText || '').split(/\r?\n/).map((line) => compact(line)).filter(Boolean);
  const header = [];
  for (const line of all.slice(0, 16)) {
    if (CV_SECTION_RE.test(line)) break;
    if (!NON_RESIDENCE_RE.test(line)) header.push(line);
  }
  const residence = all.filter((line) => GENERAL_ADDRESS_LABEL_RE.test(line) && !NON_RESIDENCE_RE.test(line));
  return [...new Set([...header, ...residence])];
}

function appearsInEvidence(value, lines) {
  const needle = key(value);
  if (!needle) return false;
  return lines.some((line) => {
    const haystack = key(line);
    return haystack === needle || ` ${haystack} `.includes(` ${needle} `);
  });
}

function countryAppearsInEvidence(country, lines) {
  const code = ({ Italia: 'IT', Svizzera: 'CH', Germania: 'DE', Francia: 'FR' })[country];
  if (!code) return false;
  const names = {
    IT: /\b(?:italia|italy|italie|italien)\b/i,
    CH: /\b(?:svizzera|switzerland|suisse|schweiz)\b/i,
    DE: /\b(?:germania|germany|allemagne|deutschland)\b/i,
    FR: /\b(?:francia|france)\b/i,
  }[code];
  const codeToken = new RegExp(`(?:^|[\\s([{:/\\-–—])${code}(?=$|[\\s)\\]}:/\\-–—])`, 'i');
  return lines.some((line) => names.test(line) || codeToken.test(line));
}

function explicitPostalCode(cvText, city, province) {
  const withoutCalendarDates = (line) => String(line || '').replace(
    /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/g,
    ' ',
  );
  const lines = cvAddressEvidenceLines(cvText).filter((line) => {
    if (NON_RESIDENCE_RE.test(line)) return false;
    if (GENERAL_ADDRESS_LABEL_RE.test(line)) return true;
    return Boolean(city && appearsInEvidence(city, [line]) && /\b\d{4,5}\b/.test(withoutCalendarDates(line)));
  });
  const codes = [...new Set(lines.flatMap((line) => withoutCalendarDates(line).match(/\b\d{4,5}\b/g) || []))];
  if (codes.length !== 1) return '';
  const code = codes[0];
  const swiss = officialLocalityPostalCode(city, province);
  if (swiss) return swiss === code ? code : '';
  if (/^(?:18|19|20)\d{2}$/.test(code) && !lines.some((line) => POSTAL_LABEL_RE.test(line))) return '';
  const italian = resolveItalianPostalCode(city, province);
  return !italian || italian === code ? code : '';
}

/** Resolve only stated address fields while preserving the candidate's wording. */
export function resolveResidenceAddress(rawAddress = {}, location = '', cvText = '') {
  const address = rawAddress && typeof rawAddress === 'object' ? rawAddress : {};
  const rawCity = compact(address.city) || compact(location);
  const province = provinceFrom(address.city) || provinceFrom(location);
  const evidenceLines = cvAddressEvidenceLines(cvText);
  const cityCandidate = cityWithoutProvince(rawCity);
  const hasCvSource = String(cvText || '').trim().length > 0;
  const city = !hasCvSource || appearsInEvidence(cityCandidate, evidenceLines) ? cityCandidate : '';
  const countryCandidate = explicitCountryFrom(address.country) || explicitCountryFrom(rawCity) || explicitCountryFrom(location);
  const country = !hasCvSource || countryAppearsInEvidence(countryCandidate, evidenceLines) ? countryCandidate : '';
  const rawStatedPostal = compact(address.postalCode, 20);
  const statedPostal = postalCodeDigits(rawStatedPostal) || rawStatedPostal;
  const postalCode = explicitPostalCode(cvText, city, province) || (hasCvSource ? '' : statedPostal);
  // Remove a known postal code copied into the street field. A bare
  // four/five-digit value is rejected below as an ambiguous postal code, while
  // longer numbers with a street remain eligible as explicit civic numbers.
  const streetCandidate = compact(address.street);
  const street = !hasCvSource || appearsInEvidence(streetCandidate, evidenceLines) ? streetCandidate : '';
  const knownPostalDigits = postalCodeDigits(postalCode);
  const streetWithoutKnownPostal = knownPostalDigits
    ? street.replace(new RegExp(`\\b${knownPostalDigits}\\b`, 'g'), ' ')
    : street;
  const cleanStreet = streetWithoutKnownPostal
    .replace(/\s+/g, ' ')
    .replace(/(?:,\s*)+$/, '')
    .trim();
  return {
    // A locality, postal code or country is not a street address. Keep it in
    // its own field and let the required street/house-number question reach
    // the candidate instead of synthesising a civic address.
    street: localityOnlyStreet(cleanStreet, {
      city: compact(address.city) || city,
      location,
      postalCode,
      country: compact(address.country) || country,
      province,
    }) ? '' : cleanStreet,
    postalCode,
    city,
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
  // Country picklists commonly append or prepend the ISO code (for example
  // «Switzerland (CH)» or «CH - Switzerland»). Match one exact two-letter
  // token; never treat a substring such as «IT» inside another label as a
  // country.
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const codeMatches = [...raw.matchAll(/(?:^|[\s([{:\/\-–—])([A-Z]{2})(?=$|[\s)\]}:\/\-–—])/gi)]
    .filter((match) => /^(?:IT|CH|DE|FR)$/i.test(match[1]));
  if (codeMatches.length > 1) return '';
  const codeMatch = codeMatches[0];
  const code = codeMatch?.[1]?.toUpperCase() || '';
  if (/^(?:IT|CH|DE|FR)$/.test(code)) {
    const start = codeMatch.index + codeMatch[0].length - code.length;
    const left = raw.slice(0, start).trimEnd().at(-1) || '';
    const right = raw.slice(start + code.length).trimStart()[0] || '';
    const countryName = {
      IT: /\b(?:italia|italy|italie|italien)\b/.test(text),
      CH: /\b(?:svizzera|switzerland|suisse|schweiz)\b/.test(text),
      DE: /\b(?:germania|germany|allemagne|deutschland)\b/.test(text),
      FR: /\b(?:francia|france)\b/.test(text),
    }[code];
    if (text === code.toLowerCase() || countryName || /[()[\]{}:\/\-–—]/.test(`${left}${right}`)) return code;
  }
  if (/^(?:it|italia|italy|italie|italien)$/.test(text)) return 'IT';
  if (/^(?:ch|svizzera|switzerland|suisse|schweiz)$/.test(text)) return 'CH';
  if (/^(?:de|germania|germany|allemagne|deutschland)$/.test(text)) return 'DE';
  if (/^(?:fr|francia|france)$/.test(text)) return 'FR';
  return '';
}

function houseNumberFromAddress(street, postalCode) {
  const knownPostalDigits = postalCodeDigits(postalCode);
  const withoutPostal = knownPostalDigits
    ? street.replace(new RegExp(`\\b${knownPostalDigits}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim()
    : street;
  const marked = withoutPostal.match(/\b(?:n[°ºo]?|no\.?|numero|numéro|civico|house\s*(?:number|no)|street\s*(?:number|no))\s*([0-9]{1,5}[A-Za-z]?)/i)?.[1];
  const leadingMatch = withoutPostal.match(/^\s*([0-9]{1,5}[A-Za-z]?)\s+(.+)$/u);
  const leading = leadingMatch && STREET_TYPE_RE.test(leadingMatch[2]) ? leadingMatch[1] : '';
  const trailingMatch = withoutPostal.match(/\b([0-9]{1,5}[A-Za-z]?)\s*$/);
  const trailingPrefix = trailingMatch ? withoutPostal.slice(0, trailingMatch.index).trim().replace(/[,.]+$/, '').trim() : '';
  const roadTypeOnly = /^(?:via|viale|piazza|piazzale|corso|strada(?:\s+(?:statale|provinciale|regionale|nazionale))?|largo|vicolo|contrada|avenue|rue|chemin|route(?:\s+nationale)?|place|boulevard|quai|gasse|strasse|straße|weg|platz|allee|street|st\.?|road|rd\.?|lane|ln\.?|drive|dr\.?)$/i.test(trailingPrefix);
  return marked || leading || (!roadTypeOnly && trailingMatch?.[1]) || '';
}

export function addressQuestionAnswer(candidate, topic, streetOverride = null) {
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
  if (streetOverride !== null && ['address', 'address_street', 'address_house_number'].includes(topic)) rawAddress.street = streetOverride;
  // Residence fields only use facts already resolved from the residence
  // address. `location` can describe a job or school and belongs only to
  // candidate contact fields, not to a home-address question.
  const address = resolveResidenceAddress(rawAddress);
  if (topic === 'address_street') return /\p{L}/u.test(address.street) ? address.street : '';
  if (topic === 'address') {
    return /\p{L}/u.test(address.street) && houseNumberFromAddress(address.street, address.postalCode)
      ? address.street
      : '';
  }
  if (topic === 'address_house_number') return houseNumberFromAddress(address.street, address.postalCode);
  if (topic === 'residence_postal_code') return address.postalCode;
  if (topic === 'residence_city') return address.city;
  if (topic === 'residence_country') return address.country;
  return '';
}
