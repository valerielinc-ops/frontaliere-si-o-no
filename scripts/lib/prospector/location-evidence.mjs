import {
  TEXT_RESCUE_AMBIGUOUS_TOKENS,
  inferSwissTargetCanton,
  isCantonRelevant,
  isKnownSwissMunicipality,
  isKnownSwissMunicipalityInCanton,
  isLiechtensteinPostalCode,
  normalizeSwissCantonCode,
  normalizeSwissTargetLocationText,
  swissCityFromLocationField,
  swissMunicipalityCantons,
} from '../target-swiss-locations.mjs';
import {
  FOREIGN_COUNTRY_NAME_LABELS,
  ISO_ALPHA2_COUNTRY_CODES,
  SWISS_COUNTRY_LABELS,
} from './country-inventory.mjs';
import {
  hasKnownForeignSubdivisionSuffix,
  isKnownForeignSubdivision,
} from './subdivision-inventory.mjs';
import {
  getCantonLocationFallback,
  getCantonPostalFallback,
  getDefaultCantonLocationFallback,
} from '../canton-postal-fallback.mjs';
import { scanMarkupStartTags, scanStartTags, readAttr } from '../html-attr.mjs';
import { decodeEntities } from './entities.mjs';
import { normalizeHost, registrableDomain } from './registrable.mjs';
import { NON_PLATFORM_HOSTS } from './config.mjs';

export const JOB_LOCATION_CLASS_TOKENS = new Set([
  'job-location', 'job_location', 'job-detail-location', 'job_detail_location',
  'job-region', 'job_region', 'job-detail-region', 'job_detail_region',
  'vacancy-location', 'vacancy_location', 'vacancy-detail-location', 'vacancy_detail_location',
  'vacancy-region', 'vacancy_region', 'vacancy-detail-region', 'vacancy_detail_region',
]);

// SuccessFactors/SuccessFactors-derived templates put one or more vacancy
// locations in a value span nested inside the job-location wrapper. The token
// is only authoritative when the caller has already established that wrapper;
// a standalone value span is common in search cards and page chrome.
export const JOB_LOCATION_VALUE_CLASS_TOKENS = new Set(['jobgeolocation']);

const OFFICIAL_LOCATION_LINK_RX = /(?:impressum|imprint|contact|kontakt|contatti?|contactez|adresse|address|indirizzo|chi[\s_-]*siamo|about[\s_-]*(?:us|company)?)/iu;
const OFFICIAL_LOCATION_SECTION_RX = /(?:impressum|imprint|contact|kontakt|contatti?|contactez|adresse|address|indirizzo|chi[\s_-]*siamo|about[\s_-]*(?:us|company)?)/iu;
const AGENCY_EMPLOYER_RX = /(?:\bpersonal(?:beratung|vermittlung|dienstleistungen|leasing|agentur)?\b|placement(?:\s+de\s+personnel)?|staffing(?:\s+agency)?|(?:employment|recruitment|work|personnel|job|talent)\s+agency|agency\s+(?:for\s+)?(?:employment|recruitment|staffing|work|personnel|jobs?)|agenzia\s+(?:per\s+il\s+lavoro|di\s+collocamento|interinale)|agence\s+(?:de\s+placement|de\s+recrutement|d['’]?emploi)|\b(?:adecco|manpower|randstad|kelly\s+services|pemsa|coopers|anker\s+swiss|flexsis|interiman|sintex|axxon(?:\s+services)?|trenkwalder)\b|\binterim\b)/iu;

/**
 * Structured location evidence selected by the shared resolver. Known address
 * fields are normalised to strings; vendor-specific fields survive the spread.
 *
 * @typedef {Record<string, any> & {
 *   location: string,
 *   addressCountry: string,
 *   country?: string,
 *   addressLocality: string,
 *   addressRegion: string,
 *   postalCode: string,
 *   streetAddress: string,
 *   duplicateCandidates?: any[],
 * }} LocationEvidenceCandidate
 */

/** @type {LocationEvidenceCandidate} */
const EMPTY_LOCATION_EVIDENCE = Object.freeze({
  location: '',
  addressCountry: '',
  addressLocality: '',
  addressRegion: '',
  postalCode: '',
  streetAddress: '',
});

/**
 * Normalize one source location part used by an authoritative foreign
 * snapshot proof. A source may prefix the locality with its postal code
 * (for example `9490 Vaduz`); the postal code is evidence attached to the
 * known locality, not a new locality name. Callers still have to compare the
 * returned value with their explicit, source-reviewed allowlist.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAuthoritativeNonSwissLocationPart(value = '') {
  return normalizeSwissTargetLocationText(value)
    .replace(/^\d{4,6}\s+/, '')
    .trim();
}

/**
 * Check a source location against a parser's reviewed non-Swiss allowlist.
 * Postal prefixes are evidence attached to the locality; every non-empty
 * locality segment must still be explicitly reviewed by that parser.
 *
 * @param {unknown} value
 * @param {ReadonlySet<string>} allowlist
 * @returns {boolean}
 */
export function isAllowlistedAuthoritativeNonSwissLocation(value, allowlist) {
  const parts = String(value || '')
    .split(/[,;&/|]/)
    .map(normalizeAuthoritativeNonSwissLocationPart)
    .filter(Boolean);
  return parts.length > 0
    && Boolean(allowlist && typeof allowlist.has === 'function')
    && parts.every((part) => allowlist.has(part));
}

function hasToken(value, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(value);
}

function hasOnlyExplicitForeignCountry(value) {
  const segments = String(value || '').split(/[,;/|()]+/)
    .map((segment) => normalizeSwissTargetLocationText(segment))
    .filter(Boolean);
  const isExplicitSegment = (label) => segments.some(
    (segment) => segment === label || segment.endsWith(` ${label}`),
  );
  const hasSwiss = [...SWISS_COUNTRY_LABELS].some(isExplicitSegment);
  // Country names only count as authoritative when they are the terminal
  // segment/value. This keeps prose and names that merely mention a country
  // from overriding a structured Swiss locality, while accepting all ISO/CLDR
  // names rather than a hand-maintained shortlist.
  const hasForeign = [...FOREIGN_COUNTRY_NAME_LABELS].some(isExplicitSegment);
  return hasForeign && !hasSwiss;
}

const CODE_OPEN_DELIMITERS = '\\s(,;/|.!?:';
const CODE_CLOSE_DELIMITERS = '\\s),;/|.!?:';
const COMMON_INITIAL_LOCATION_TOKENS = new Set(['ST', 'LA', 'LE']);

function locationRegionKey(value, addressCountry = '') {
  const raw = String(value || '').trim();
  const canton = normalizeSwissCantonCode(raw);
  if (canton) return canton;
  const region = normalizeSwissTargetLocationText(raw);
  if (!region) return '';
  // A free-text subdivision is not a Swiss canton. Keep the country in its
  // identity, and make the absence of country explicit, so an unknown foreign
  // region cannot be treated as a country-less Swiss-shaped value.
  const country = normalizeSwissTargetLocationText(addressCountry) || 'unknown';
  return `${country}:${region}`;
}

function locationCodes(value) {
  const raw = String(value || '');
  const uppercase = [...raw.matchAll(new RegExp(`(?:^|[${CODE_OPEN_DELIMITERS}])([A-Z]{2})(?=$|[${CODE_CLOSE_DELIMITERS}]|\\d{4,10}\\b)`, 'g'))]
    .filter((match) => {
      const tokenStart = (match.index || 0) + match[0].lastIndexOf(match[1]);
      const commonPrefix = COMMON_INITIAL_LOCATION_TOKENS.has(match[1])
        && !raw.slice(0, tokenStart).trim()
        && /^[.\s-]+\p{L}/u.test(raw.slice(tokenStart + match[1].length));
      return !commonPrefix;
    })
    .map((match) => match[1]);
  // Lowercase codes are accepted only in country/canton-shaped positions.
  // Scanning every two-letter lowercase word would misread prose such as
  // "Canton de Vaud" (`de`) as ISO-DE.
  const shaped = [...raw.matchAll(new RegExp(
    `(?:\\(([a-z]{2})\\)|^([a-z]{2})(?=\\s*\\d{3,10}\\b)|[${CODE_OPEN_DELIMITERS}]([a-z]{2})(?=\\s*\\d{3,10}\\b|\\s*[),;/|.!?:]|$))`,
    'gi',
  ))]
    .map((match) => match[1] || match[2] || match[3]);
  return [...new Set([...uppercase, ...shaped].map((code) => code.toUpperCase()))]
    .map((code) => ({ code }));
}

function stripLocationCodes(value, codes = locationCodes(value)) {
  let out = String(value || '');
  for (const { code } of codes) {
    const codePattern = new RegExp(`(^|[${CODE_OPEN_DELIMITERS}])${code}(?=$|[${CODE_CLOSE_DELIMITERS}]|\\d{4,10}\\b)`, 'gi');
    out = out.replace(codePattern, (_match, prefix) => prefix || '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function explicitCorroboratedCanton(value, codes = locationCodes(value), withoutCodes = stripLocationCodes(value, codes)) {
  for (const code of codes) {
    if (code.code === 'CH') continue;
    if (isCantonRelevant(withoutCodes, code.code, { includeBorderProximity: false })) return code.code;
    const localityBeforeCode = String(value || '').match(new RegExp(
      `(?:^|[,;/|])\\s*([^,;/|]+?)(?:\\s+|\\s*[,;/|]\\s*)${code.code}(?=$|[${CODE_CLOSE_DELIMITERS}]|\\s+\\d{3,10}\\b)`,
      'i',
    ))?.[1]?.trim();
    if (localityBeforeCode && isKnownSwissMunicipalityInCanton(localityBeforeCode, code.code)) return code.code;
  }
  return '';
}

function hasUncorroboratedForeignSubdivision(value) {
  if (!hasKnownForeignSubdivisionSuffix(value)) return false;
  const codes = locationCodes(value);
  const withoutCodes = stripLocationCodes(value, codes);
  // ISO-3166-2 has unavoidable collisions with Swiss canton codes (AR, NE,
  // ...). A colliding suffix remains Swiss only when the locality independently
  // corroborates that canton; unfamiliar NY/ON and named foreign subdivisions
  // remain authoritative negative evidence.
  return !codes.some(({ code }) => normalizeSwissCantonCode(code)
    && explicitCorroboratedCanton(value, [{ code }], withoutCodes) === code);
}

function hasUncorroboratedTerminalCountryCode(value, codes, withoutCodes) {
  const raw = String(value || '').trim();
  return codes.some(({ code }) => {
    // Two-letter tokens are not countries by shape alone: Swiss locations and
    // employer labels routinely end in HQ, HO or EP. Only an assigned ISO
    // alpha-2 code can be authoritative negative country evidence.
    if (code === 'CH' || !ISO_ALPHA2_COUNTRY_CODES.has(code)) return false;
    const countryShaped = new RegExp(
      `(?:\\(${code}\\)|(?:^|[,;/|]\\s*)${code}(?=\\s+\\d{3,10}\\b|[.!?:]*$)|\\b${code}(?=\\s+\\d{3,10}\\b|[.!?:]*$))`,
      'i',
    ).test(raw);
    if (!countryShaped) return false;
    if (isCantonRelevant(withoutCodes, code, { includeBorderProximity: false })) return false;
    return explicitCorroboratedCanton(value, [{ code }], withoutCodes) !== code;
  });
}

function isSwissCountry(value) {
  const country = normalizeSwissTargetLocationText(value);
  return Boolean(country && [...SWISS_COUNTRY_LABELS].some((label) => hasToken(country, label)));
}

function isSourceLocationMetadataSuffix(value) {
  const normalized = normalizeSwissTargetLocationText(value);
  if (!normalized) return true;
  if (isSwissCountry(normalized)) return true;
  return normalized.split(' ').every((token) => token === 'ch'
    || token === 'hq'
    || token === 'ho'
    || token === 'ep'
    || /^\d{4,10}$/.test(token)
    || Boolean(normalizeSwissCantonCode(token)));
}

function structuredLocalityCorroboratesLocation(location, locality) {
  const localityKey = normalizeSwissTargetLocationText(locality);
  if (!localityKey) return false;
  return String(location || '').split(/[,;/|]/).some((segment) => {
    const normalizedSegment = normalizeSwissTargetLocationText(segment)
      .replace(/^(?:ch\s*)?\d{4,10}\s+/, '')
      .trim();
    if (normalizedSegment === localityKey) return true;
    if (!normalizedSegment.startsWith(`${localityKey} `)) return false;
    return isSourceLocationMetadataSuffix(normalizedSegment.slice(localityKey.length + 1));
  });
}

export function isExplicitlyForeign(value, addressCountry = '') {
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
 * @returns {{ location: string, canton: string, addressCountry?: string, postalCode?: string, streetAddress?: string }|null}
 */
export function resolveSourceBackedSwissGeography(value, addressCountry = '') {
  const evidence = /** @type {any} */ (value && typeof value === 'object'
    ? value
    : { location: value, addressCountry });
  const structuredLocationInput = Boolean(value && typeof value === 'object');
  const location = String(evidence.location || evidence.addressLocality || '').replace(/\s+/g, ' ').trim();
  const country = String(evidence.addressCountry || evidence.country || addressCountry || '').trim();
  const addressLocality = String(evidence.addressLocality || '').replace(/\s+/g, ' ').trim();
  const addressRegion = String(evidence.addressRegion || '').replace(/\s+/g, ' ').trim();
  // Swiss Post localities are finer-grained than BFS communes (for example
  // `Le Lignon`, 1219, belongs to GE but is not a commune). They are safe
  // source evidence when the vacancy carries the postal pair OR an explicit
  // structured canton alongside the locality. A bare locality remains
  // fail-closed so prose cannot become geography.
  const hasPostalAddressEvidence = Boolean(String(evidence.postalCode || '').trim())
    || /(?:^|\D)(?:CH[\s-]?)?\d{4}(?:\D|$)/.test(location);
  if (!location) return null;
  // Municipality names have international homonyms (e.g. Provence VD). An
  // explicit terminal country segment from the source outranks that fuzzy
  // token match. Multi-location rows that also name Switzerland remain valid.
  if (isExplicitlyForeign(location, country) || hasUncorroboratedForeignSubdivision(location)) return null;
  const structuredCanton = normalizeSwissCantonCode(addressRegion);
  const hasStructuredLocalityEvidence = Boolean(addressLocality
    && structuredCanton
    && structuredLocalityCorroboratesLocation(location, addressLocality));
  const allowOfficialLocality = hasPostalAddressEvidence || hasStructuredLocalityEvidence;
  // addressRegion is an explicit subdivision slot. A value that is not one of
  // the 26 Swiss cantons is authoritative negative evidence, irrespective of
  // whether it came from a familiar foreign inventory entry such as NY/ON or
  // an uncommon subdivision not yet seen in the crawler corpus.
  if (addressRegion && !structuredCanton) return null;
  const codes = locationCodes(location);
  const withoutCodes = stripLocationCodes(location, codes);
  // A source can publish both a municipality and an explicit canton marker.
  // Prefer the marker only when the remaining text independently corroborates
  // it: this resolves "Brügg BE, Bern" before fuzzy "Brugg" → AG, without
  // treating the legal-form suffix in "Company AG, Zürich" as canton Aargau.
  const explicitCanton = structuredCanton || explicitCorroboratedCanton(location, codes, withoutCodes);
  const locality = addressLocality || withoutCodes.split(/[,;/|]/)[0]
    .replace(/\b(?:switzerland|schweiz|suisse|svizzera|svizra)\b\s*$/i, '')
    .trim();
  // A bare Zürich plus a postal code still lacks a source-backed target-canton
  // signal when the source did not provide an explicit locality or country.
  // Reject it before the official-locality branch can treat the country-wide
  // registry hit as sufficient evidence.
  if (hasPostalAddressEvidence && !addressLocality && !country
    && normalizeSwissTargetLocationText(location) === 'zurich') return null;
  const municipalityCantons = swissMunicipalityCantons(locality, {
    includeOfficialLocalities: allowOfficialLocality,
  });
  if (!explicitCanton && municipalityCantons.length > 1) return null;
  if (explicitCanton && addressLocality
    && !isKnownSwissMunicipalityInCanton(addressLocality, explicitCanton, {
      allowOfficialLocality,
    })) return null;
  const localityCanton = !explicitCanton && municipalityCantons.length === 1
    ? municipalityCantons[0]
    : '';
  // `swissMunicipalityCantons` is country-wide. Keep the target-canton guard
  // on this inferred path instead of treating a unique registry hit as proof
  // that the source location belongs to the configured funnel. The resolver
  // has one relevance path; source-backed locality evidence only broadens the
  // official-locality tokens accepted by `isCantonRelevant`.
  const localityIsRelevant = localityCanton && isCantonRelevant(locality, localityCanton, {
    includeBorderProximity: false,
    includeOfficialLocality: allowOfficialLocality,
  });
  if (localityCanton && !localityIsRelevant) return null;
  // A bare canton label is not enough source-backed locality evidence: unlike
  // a named municipality such as Winterthur, it can describe a broad region.
  // Keep an explicit country or postal pair as the stronger source signal.
  // `locationCodes` may strip a non-geographic employer suffix such as HQ,
  // HO or EP before deriving `locality`; only the exact bare source value is
  // the ambiguous canton-only case, not a decorated workplace label.
  if (localityCanton && !structuredLocationInput && !country && !hasPostalAddressEvidence && !isSwissCountry(location)
    && localityCanton === 'ZH' && normalizeSwissCantonCode(locality) === localityCanton
    && normalizeSwissTargetLocationText(location) === normalizeSwissTargetLocationText(locality)) return null;
  const canton = explicitCanton || localityCanton || inferSwissTargetCanton(withoutCodes);
  if (!canton || (!explicitCanton && !localityIsRelevant
    && !isCantonRelevant(withoutCodes, canton, {
      includeBorderProximity: false,
      includeOfficialLocality: allowOfficialLocality,
    }))) return null;
  const postalCode = String(evidence.postalCode || '').replace(/\s+/g, ' ').trim();
  const streetAddress = String(evidence.streetAddress || '').replace(/\s+/g, ' ').trim();
  const geography = { location, canton };
  if (country) geography.addressCountry = country;
  if (postalCode) geography.postalCode = postalCode;
  if (streetAddress) geography.streetAddress = streetAddress;
  return geography;
}

/**
 * Project a resolved source geography into the structured address fields used
 * by a published job row. The resolver deliberately returns only the compact
 * `{ location, canton }` identity because most callers only need that pair;
 * parsers that publish schema.org fields must use the resolved canton again,
 * rather than copying a raw `addressRegion` that may be a display name or a
 * stale value from a different extraction stage.
 *
 * @param {unknown} value source location or structured source evidence
 * @param {{location: string, canton: string, addressCountry?: string}|null} [resolved]
 * @returns {{location: string, canton: string, addressLocality: string, addressRegion: string, addressCountry?: string, postalCode?: string, streetAddress?: string}|null}
 */
export function sourceBackedSwissGeographyFields(value, resolved = null) {
  const geography = resolved || resolveSourceBackedSwissGeography(value);
  if (!geography) return null;
  const evidence = value && typeof value === 'object' ? /** @type {any} */ (value) : {};
  const rawAddressLocality = String(evidence.addressLocality || '')
    .replace(/\s+/g, ' ').trim();
  const sourceLocationParts = String(geography.location || '')
    .split(/[,;/|]/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const rawLocalityIsInResolvedCanton = rawAddressLocality
    && isKnownSwissMunicipalityInCanton(rawAddressLocality, geography.canton, {
      allowOfficialLocality: true,
    });
  // Multi-area source labels can carry a locality from another canton, an
  // ambiguous municipality, or a translated canton name in addressLocality.
  // When the resolver has already established the target canton, select a
  // concrete municipality from the source location parts in that canton. Do
  // not reinterpret a concrete locality already verified in that canton or
  // invent one from a broad single-area label.
  const sourceBackedLocality = sourceLocationParts
    .map((part) => {
      // Keep an exact source-backed official locality (for example
      // `Seewis Dorf`) before canonicalising municipality aliases. The
      // official locality is the stronger address evidence and may carry a
      // distinct postal locality from its parent municipality.
      if (isKnownSwissMunicipalityInCanton(part, geography.canton, {
        allowOfficialLocality: true,
      })) return part;
      return swissCityFromLocationField(part, geography.canton);
    })
    .find((candidate) => candidate
      && isKnownSwissMunicipalityInCanton(candidate, geography.canton, {
        allowOfficialLocality: true,
      })) || '';
  const isMultiArea = sourceLocationParts.length > 1;
  const addressLocality = rawAddressLocality
    && !(isMultiArea && !rawLocalityIsInResolvedCanton)
    ? rawAddressLocality
    : sourceBackedLocality
      // A multi-area source is not evidence for the first arbitrary token.
      // If none of its parts resolves in the verified canton, fail closed
      // instead of publishing a foreign locality with a Swiss canton.
      || (isMultiArea ? '' : rawAddressLocality || sourceLocationParts[0] || '');
  const addressCountry = String(
    geography.addressCountry || evidence.addressCountry || evidence.country || '',
  ).replace(/\s+/g, ' ').trim();
  const postalCode = String(geography.postalCode || '').replace(/\s+/g, ' ').trim();
  const streetAddress = String(geography.streetAddress || '').replace(/\s+/g, ' ').trim();
  return {
    ...geography,
    addressLocality,
    // `geography.canton` is the value the source resolver actually verified.
    // Never copy the raw structured field here: that is the mismatch this
    // projection prevents at the parser → assembler handoff.
    addressRegion: geography.canton,
    ...(addressCountry ? { addressCountry } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(streetAddress ? { streetAddress } : {}),
  };
}

/**
 * Project source-backed geography into the complete address shape required by
 * the JobPosting producer. Source address values win; when a listing only
 * carries a verified locality/canton, use the reviewed canton-level fallback
 * for the postal code and the known locality as the non-fictional street value.
 * The schema builder applies its own source-provenance checks downstream.
 *
 * @param {unknown} value source location or structured source evidence
 * @param {{location: string, canton: string, addressCountry?: string}|null} [resolved]
 * @returns {{location: string, canton: string, addressLocality: string, addressRegion: string, addressCountry?: string, postalCode: string, streetAddress: string}|null}
 */
export function sourceBackedSwissJobAddressFields(value, resolved = null) {
  const fields = sourceBackedSwissGeographyFields(value, resolved);
  if (!fields) return null;

  const locality = String(fields.addressLocality || fields.location || '')
    .replace(/\s+/g, ' ')
    .trim();
  const cantonFallback = getCantonLocationFallback(fields.canton)
    || getDefaultCantonLocationFallback();
  const postalCode = String(fields.postalCode || '').replace(/\s+/g, ' ').trim()
    || getCantonPostalFallback(fields.canton, locality)
    || String(cantonFallback?.postalCode || '').trim();
  const streetAddress = String(fields.streetAddress || '').replace(/\s+/g, ' ').trim()
    || locality
    || String(cantonFallback?.city || '').trim();

  return { ...fields, postalCode, streetAddress };
}

/**
 * Stable identity of a location evidence candidate: the six address fields
 * that make two candidates the same place. Anything else a producer hangs on
 * the object (source url, extractor name) is provenance, not identity.
 *
 * Exported because folding evidence into a row has to be idempotent: the
 * accumulator and the voter must agree on what "already there" means, or
 * `f(f(row))` grows the array while the vote sees one candidate.
 *
 * @param {any} candidate
 * @returns {string}
 */
export function locationEvidenceKey(candidate) {
  if (typeof candidate === 'string') return [candidate.trim(), '', '', '', '', ''].join('\u0000');
  const addressCountry = String(candidate?.addressCountry || candidate?.country || '').trim();
  return [
    String(candidate?.location || '').trim(),
    addressCountry,
    String(candidate?.addressLocality || '').trim(),
    locationRegionKey(candidate?.addressRegion, addressCountry),
    String(candidate?.postalCode || '').trim(),
    String(candidate?.streetAddress || '').trim(),
  ].join('\u0000');
}

const DUPLICATE_CANDIDATES_FIELD = 'duplicateCandidates';

function candidateComparable(candidate) {
  if (typeof candidate === 'string') return { type: 'string', value: candidate.trim() };
  if (!candidate || typeof candidate !== 'object') return { type: typeof candidate, value: String(candidate ?? '') };
  return Object.fromEntries(Object.keys(candidate)
    .filter((key) => key !== DUPLICATE_CANDIDATES_FIELD)
    .sort()
    .map((key) => [key, candidate[key]]));
}

function candidatesEquivalent(left, right) {
  return JSON.stringify(candidateComparable(left)) === JSON.stringify(candidateComparable(right));
}

function candidateQuality(candidate) {
  if (candidate === null || candidate === undefined) return { object: -1, fields: 0 };
  if (typeof candidate === 'string') return { object: 0, fields: 0 };
  if (typeof candidate !== 'object') return { object: -1, fields: 0 };
  const fields = candidate && typeof candidate === 'object'
    ? Object.entries(candidate).filter(([key, value]) => key !== DUPLICATE_CANDIDATES_FIELD
      && value !== undefined && value !== null && String(value).trim() !== '').length
    : 0;
  return { object: 1, fields };
}

function isPreferredCandidate(candidate, current) {
  const incoming = candidateQuality(candidate);
  const existing = candidateQuality(current);
  return incoming.object > existing.object
    || (incoming.object === existing.object && incoming.fields > existing.fields);
}

function candidateTrace(candidate) {
  if (!candidate || typeof candidate !== 'object') return [candidate];
  return [candidate, ...(Array.isArray(candidate[DUPLICATE_CANDIDATES_FIELD])
    ? candidate[DUPLICATE_CANDIDATES_FIELD]
    : [])];
}

function attachDuplicateTrace(candidate, duplicates) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const existing = Array.isArray(candidate[DUPLICATE_CANDIDATES_FIELD])
    ? candidate[DUPLICATE_CANDIDATES_FIELD]
    : [];
  const trace = [...existing];
  for (const duplicate of duplicates.flatMap(candidateTrace)) {
    if (candidatesEquivalent(duplicate, candidate)) continue;
    if (trace.some((entry) => candidatesEquivalent(entry, duplicate))) continue;
    trace.push(duplicate);
  }
  return trace.length ? { ...candidate, [DUPLICATE_CANDIDATES_FIELD]: trace } : candidate;
}

/**
 * Drop candidates that repeat a place already present, preferring the richer
 * object over a bare string and retaining every non-identical loser as
 * `duplicateCandidates`. A string/object collision therefore cannot erase the
 * source URL or extractor metadata carried by the object, and reapplying the
 * fold to the same evidence stays idempotent.
 *
 * @param {any[]} candidates
 * @returns {any[]}
 */
export function dedupeLocationCandidates(candidates = []) {
  const groups = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate === null || candidate === undefined
      || Array.isArray(candidate)
      || (typeof candidate !== 'string' && typeof candidate !== 'object')) continue;
    const key = locationEvidenceKey(candidate);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { winner: candidate, duplicates: [] });
      continue;
    }
    if (candidatesEquivalent(current.winner, candidate)) continue;
    if (isPreferredCandidate(candidate, current.winner)) {
      current.duplicates.push(current.winner);
      current.winner = candidate;
    } else {
      current.duplicates.push(candidate);
    }
  }
  return [...groups.values()].map(({ winner, duplicates }) => attachDuplicateTrace(winner, duplicates));
}

/**
 * @param {any} record
 * @returns {LocationEvidenceCandidate[]}
 */
export function locationEvidenceCandidates(record = {}) {
  /** @type {any[]} */
  const candidates = Array.isArray(record?.locationCandidates) ? [...record.locationCandidates] : [];
  const addressLocality = String(record?.addressLocality || '').trim();
  const addressRegion = String(record?.addressRegion || '').trim();
  const fallback = {
    location: String(record?.location || [addressLocality, addressRegion].filter(Boolean).join(', ')).trim(),
    addressCountry: String(record?.addressCountry || record?.country || '').trim(),
    addressLocality,
    addressRegion,
    postalCode: String(record?.postalCode || '').trim(),
    streetAddress: String(record?.streetAddress || '').trim(),
  };
  if (fallback.location || fallback.addressCountry || fallback.postalCode || fallback.streetAddress) candidates.push(fallback);
  const normalized = dedupeLocationCandidates(candidates)
    .map((candidate) => typeof candidate === 'string'
      ? { ...EMPTY_LOCATION_EVIDENCE, location: candidate }
      : {
          ...candidate,
          location: String(candidate?.location || '').trim(),
          addressCountry: String(candidate?.addressCountry || candidate?.country || '').trim(),
          addressLocality: String(candidate?.addressLocality || '').trim(),
          addressRegion: String(candidate?.addressRegion || '').trim(),
          postalCode: String(candidate?.postalCode || '').trim(),
          streetAddress: String(candidate?.streetAddress || '').trim(),
        })
    .filter((candidate) => candidate.location || candidate.addressCountry);
  return dedupeLocationCandidates(normalized);
}

/**
 * @param {LocationEvidenceCandidate[]} candidates
 * @returns {{
 *   geography: { location: string, canton: string, addressCountry?: string } | null,
 *   explicitlyForeign: boolean,
 *   hasDeclaredLocation: boolean,
 *   candidate: LocationEvidenceCandidate,
 * }}
 */
export function evaluateSourceBackedSwissGeography(candidates = []) {
  let explicitlyForeign = false;
  const hasDeclaredLocation = (Array.isArray(candidates) ? candidates : []).some((candidate) => (
    String(candidate?.location || '').trim()
      || String(candidate?.addressLocality || '').trim()
      || String(candidate?.addressRegion || '').trim()
      || String(candidate?.postalCode || '').trim()
      || String(candidate?.streetAddress || '').trim()
      || String(candidate?.addressCountry || candidate?.country || '').trim()
  ));
  for (const candidate of candidates) {
    const location = String(candidate?.location || '').trim();
    const country = String(candidate?.addressCountry || candidate?.country || '').trim();
    const region = String(candidate?.addressRegion || '').trim();
    const regionCanton = normalizeSwissCantonCode(region);
    const hasPostalAddressEvidence = Boolean(String(candidate?.postalCode || '').trim())
      || /(?:^|\D)(?:CH[\s-]?)?\d{4}(?:\D|$)/.test(location);
    const regionLocality = String(candidate?.addressLocality || stripLocationCodes(location))
      .replace(/^\s*(?:CH[\s-]?)?\d{4}\s+/i, '')
      .trim();
    const hasStructuredLocalityEvidence = Boolean(regionCanton
      && regionLocality
      && structuredLocalityCorroboratesLocation(location, regionLocality));
    const allowOfficialLocality = hasPostalAddressEvidence || hasStructuredLocalityEvidence;
    const regionIsCorroboratedSwiss = Boolean(regionCanton
      && isKnownSwissMunicipalityInCanton(regionLocality, regionCanton, {
        allowOfficialLocality,
      }));
    if (isExplicitlyForeign(location, country)
      || hasUncorroboratedForeignSubdivision(location)
      || (region && !regionCanton)
      // Codes such as AR/NE can name both a Swiss canton and a foreign
      // subdivision. Keep the foreign veto unless the source locality proves
      // that this structured region is the Swiss canton.
      || (isKnownForeignSubdivision(region) && !regionIsCorroboratedSwiss)) {
      explicitlyForeign = true;
      continue;
    }
    const geography = resolveSourceBackedSwissGeography(candidate, country);
    if (geography) return { geography, explicitlyForeign, hasDeclaredLocation, candidate };
  }
  return { geography: null, explicitlyForeign, hasDeclaredLocation, candidate: EMPTY_LOCATION_EVIDENCE };
}

/** @returns {{ geography: null, explicitlyForeign: false, hasDeclaredLocation: false, candidate: LocationEvidenceCandidate }} */
function noGeography() {
  return { geography: null, explicitlyForeign: false, hasDeclaredLocation: false, candidate: EMPTY_LOCATION_EVIDENCE };
}

// `1201 Genève`, `CH-8003 Zürich`: the same pair `renderedPostalAddressCandidates()`
// reads inside an address block, matched here against the WHOLE page text.
// Nothing out here says the pair is an address rather than a sentence, which is
// why a match is evidence only after the cross-page rule below has removed what
// the employer prints on every page.
const FREE_TEXT_POSTAL_RX = /(?:^|[\s,;(])(?:CH[\s-]?)?(\d{4})\s+(\p{Lu}[\p{L}'’.-]*(?:[ -]\p{L}[\p{L}'’.-]*){0,3})/gu;

/**
 * The longest leading run of the matched words that names a BFS municipality.
 * The regex cannot know where the place name ends — `8618 Oetwil am See Wir
 * suchen` — so the gazetteer decides, longest first.
 *
 * `TEXT_RESCUE_AMBIGUOUS_TOKENS` is the same blocklist the description rescue
 * uses: `alle` is a municipality (JU) and the German word "all", and prose is
 * full of it. A postal code in front of it does not make the sentence an
 * address.
 */
function knownMunicipalityPrefix(name = '') {
  const words = String(name).split(/\s+/).filter(Boolean);
  for (let size = words.length; size >= 1; size -= 1) {
    // Trailing sentence punctuation is not part of the name: `4528 Zuchwil.`
    // resolves through the gazetteer, which normalises it away, and would
    // otherwise be published verbatim with the full stop attached.
    const candidate = words.slice(0, size).join(' ').replace(/[.\-'’]+$/, '');
    if (TEXT_RESCUE_AMBIGUOUS_TOKENS.has(normalizeSwissTargetLocationText(candidate))) continue;
    if (isKnownSwissMunicipality(candidate)) return candidate;
  }
  return '';
}

/**
 * Postal-code + municipality pairs written in a page's free text, in document
 * order. Requiring BOTH halves is what keeps a number out of the gazetteer:
 * `1271 Euro` names a real postal code (Givrins VD) and no municipality, so it
 * yields nothing.
 *
 * This is raw evidence, not a decision: callers must still pass it through
 * `variablePostalGeography()` with the employer's boilerplate, because a
 * detail page names the employer's own seat as readily as the workplace.
 *
 * @param {string} text
 * @returns {LocationEvidenceCandidate[]}
 */
export function freeTextPostalCandidates(text = '') {
  const out = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(FREE_TEXT_POSTAL_RX)) {
    const postalCode = match[1];
    // 1000 is the lowest Swiss postal code; 9485-9498 is Liechtenstein, which
    // is out of scope for canton inference.
    if (Number(postalCode) < 1000 || isLiechtensteinPostalCode(postalCode)) continue;
    const addressLocality = knownMunicipalityPrefix(match[2].replace(/\s+/g, ' ').trim());
    if (!addressLocality) continue;
    const location = `${postalCode} ${addressLocality}`;
    const key = location.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...EMPTY_LOCATION_EVIDENCE, location, addressLocality, postalCode });
  }
  return out;
}

/**
 * The share of an employer's pages a postal location has to appear on before it
 * counts as boilerplate. A FRACTION, not "all of them": strict membership makes
 * the set shrink monotonically with the number of pages observed, and the two
 * callers do not observe the same number — `gradeExtraction()` samples
 * `sampleSize` pages, `crawlSpec()` walks the whole listing. A seat printed on
 * 6/6 sampled pages but missing from one of N production pages (a variant
 * footer, a layout that answers without the contact block) would leave the set
 * exactly where the sample cannot see it, and on a page whose only pair IS that
 * seat `variablePostalGeography()` would then publish the employer's address as
 * the vacancy's workplace. A ratio is scale-invariant: sample and full run
 * classify the same location the same way.
 */
const BOILERPLATE_PAGE_SHARE = 0.6;

/**
 * The postal locations an employer prints on most of its pages — its own seat,
 * in other words, not the workplace of any single vacancy. Measured on
 * physioswiss.ch on 2026-09-06: six detail pages, `3013 Bern` (the
 * association's seat) on all six, one further pair per page and each of them
 * the vacancy's actual town.
 *
 * Pages with no pair at all are excluded from the count: they say nothing about
 * what is boilerplate, and counting them in the denominator would push every
 * location below quorum and let the seat through as if it were the workplace.
 *
 * The quorum floor of 2 keeps the two-page case as strict as it was: one page
 * out of two is variance, not repetition.
 *
 * Returns `null` — not `[]` — when fewer than two pages carry a pair: the
 * criterion is variance across pages, and with one page there is no variance
 * to observe. `[]` means "measured, this employer repeats nothing".
 *
 * @param {LocationEvidenceCandidate[][]} pages per-page output of `freeTextPostalCandidates()`
 * @returns {string[]|null}
 */
export function constantPostalLocations(pages = []) {
  const withEvidence = (Array.isArray(pages) ? pages : [])
    .map((page) => new Set((page || []).map((candidate) => String(candidate?.location || '').toLowerCase())))
    .filter((page) => page.size > 0);
  if (withEvidence.length < 2) return null;
  const pagesSeenOn = new Map();
  for (const page of withEvidence) {
    for (const location of page) pagesSeenOn.set(location, (pagesSeenOn.get(location) || 0) + 1);
  }
  const quorum = Math.max(2, Math.ceil(withEvidence.length * BOILERPLATE_PAGE_SHARE));
  return [...pagesSeenOn.entries()]
    .filter(([, seenOn]) => seenOn >= quorum)
    .map(([location]) => location);
}

/**
 * Decide a page's geography from the postal pair that VARIES across the
 * employer's pages, behind the same source-backed guard every other candidate
 * goes through: the canton still has to come from the municipality the page
 * itself names.
 *
 * Two conditions, both refusals rather than guesses:
 *   - `boilerplate` must be an array, i.e. the caller actually observed the
 *     employer's other pages. Without that observation a constant seat is
 *     indistinguishable from a workplace, which is the failure this rule
 *     exists to avoid;
 *   - exactly one pair must remain. Two of them on one page is an ambiguity
 *     the page does not resolve, and picking either would fabricate a
 *     location.
 *
 * @param {LocationEvidenceCandidate[]} candidates
 * @param {string[]|null} boilerplate
 */
export function variablePostalGeography(candidates = [], boilerplate = null) {
  if (!Array.isArray(boilerplate)) return noGeography();
  const constant = new Set(boilerplate.map((location) => String(location || '').toLowerCase()));
  const variable = (candidates || []).filter(
    (candidate) => !constant.has(String(candidate?.location || '').toLowerCase()),
  );
  if (variable.length !== 1) return noGeography();
  return evaluateSourceBackedSwissGeography(variable);
}

/**
 * @param {any} [detail]
 * @param {any} [listing]
 * @param {{ postalTextCandidates?: LocationEvidenceCandidate[], boilerplatePostalLocations?: string[]|null, officialEmployerSiteLocation?: { geography?: any|null, candidate?: any|null, evidence?: any|null } }} [pageContext]
 *   free-text evidence for THIS page plus the employer's boilerplate, both
 *   produced by the caller that saw the other pages. Absent (the default), the
 *   free-text tier stays off and behaviour is exactly what it was.
 * @returns {{
 *   geography: { location: string, canton: string, addressCountry?: string } | null,
 *   explicitlyForeign: boolean,
 *   hasDeclaredLocation: boolean,
 *   candidate: LocationEvidenceCandidate,
 * }}
 */
export function resolveDetailOrListingSwissGeography(detail = {}, listing = {}, pageContext = {}) {
  // `locationGateRejected` marks a tenant-specific extractor that already
  // verified and refused a candidate (e.g. a canton suffix mismatch): treat
  // it like an authoritative conflict, not an absence of evidence, so the
  // rejected signal cannot be silently overwritten by a generic listing
  // fallback re-deriving a different geography.
  if (detail?.authoritativeLocationConflict || detail?.locationGateRejected) {
    return { geography: null, explicitlyForeign: true, hasDeclaredLocation: true, candidate: EMPTY_LOCATION_EVIDENCE };
  }
  const detailDecision = evaluateSourceBackedSwissGeography(locationEvidenceCandidates(detail));
  if (detailDecision.geography || detailDecision.explicitlyForeign) return detailDecision;
  const listingDecision = evaluateSourceBackedSwissGeography(locationEvidenceCandidates(listing));
  if (listingDecision.geography || listingDecision.explicitlyForeign) return listingDecision;
  // Last tier: no structured field on either page named a place, so read the
  // one the page prints in its own prose. Only reached when the structured
  // cascade found nothing, so it can never override a source-backed field.
  const textDecision = variablePostalGeography(
    pageContext?.postalTextCandidates || [],
    pageContext?.boilerplatePostalLocations ?? null,
  );
  if (textDecision.geography || textDecision.explicitlyForeign) return textDecision;
  // The employer's official address is a last-resort proof only. Any
  // location declared by the vacancy, even one the Swiss resolver cannot map,
  // blocks this tier: an offer-specific workplace outranks the employer's
  // single-site address and an unknown must remain unknown.
  const offerDeclared = detailDecision.hasDeclaredLocation
    || listingDecision.hasDeclaredLocation
    || textDecision.hasDeclaredLocation;
  const official = pageContext?.officialEmployerSiteLocation;
  if (!offerDeclared && official?.geography && official?.candidate) {
    return {
      geography: official.geography,
      explicitlyForeign: false,
      hasDeclaredLocation: false,
      candidate: official.candidate,
    };
  }
  return listingDecision;
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
 * Some JSON-LD producers append the ISO country code to `addressRegion`
 * (`ZH,CH`, `Lombardy,IT`) while also supplying `addressCountry`. Keep the
 * region as the source declares it, but remove only that redundant terminal
 * country segment before the structured geography resolver validates it.
 */
function schemaAddressRegion(addressRegion, addressCountry) {
  const region = structuredText(addressRegion);
  const country = structuredText(addressCountry).toUpperCase();
  if (!region || !/^[A-Z]{2,3}$/.test(country)) return region;
  const parts = region.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.at(-1)?.toUpperCase() === country
    ? parts.slice(0, -1).join(', ')
    : region;
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
      const addressCountry = structuredText(address.addressCountry);
      const addressRegion = schemaAddressRegion(address.addressRegion, addressCountry);
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

function plainOfficialPageText(html = '') {
  return decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return the inner HTML of one element without letting a nested element with
 * the same tag terminate the block early. This is intentionally local to the
 * official-site proof: the block is only used to read address-shaped text in
 * an already selected footer/contact/impressum container.
 *
 * @param {string} html
 * @param {{ name: string, end: number }} opening
 * @param {number} [cap]
 * @returns {string}
 */
function balancedOfficialElement(html, opening, cap = 30000) {
  const rest = String(html || '').slice(opening.end, opening.end + cap);
  const tagRx = new RegExp(`<(/?)${opening.name}\\b[^>]*>`, 'gi');
  let depth = 1;
  let match;
  while ((match = tagRx.exec(rest))) {
    if (match[1]) depth -= 1;
    else depth += 1;
    if (depth === 0) return rest.slice(0, match.index);
  }
  return rest;
}

function officialPageKind(pageUrl = '', hint = '') {
  const hinted = String(hint || '').trim().toLowerCase();
  if (hinted) return hinted;
  let pathname = '';
  try { pathname = new URL(pageUrl).pathname; } catch { /* keep empty */ }
  if (/impressum|imprint/i.test(pathname)) return 'impressum';
  if (/contact|kontakt|contatt|contactez|adresse|address|indirizzo/i.test(pathname)) return 'contact';
  return 'homepage';
}

function officialStructuralBlocks(html = '', pageUrl = '', pageKind = '') {
  const kind = officialPageKind(pageUrl, pageKind);
  const blocks = [];
  const seen = new Set();
  for (const opening of scanMarkupStartTags(html)) {
    const attributes = [
      readAttr(opening.raw, ['class', 'id', 'aria-label', 'data-testid']),
    ].join(' ');
    const structural = opening.name === 'footer' || opening.name === 'address'
      || OFFICIAL_LOCATION_SECTION_RX.test(attributes)
      || (kind !== 'homepage' && ['main', 'article', 'body'].includes(opening.name));
    if (!structural) continue;
    const block = balancedOfficialElement(html, opening);
    const key = `${opening.index}:${opening.name}:${block.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const labelled = OFFICIAL_LOCATION_SECTION_RX.test(attributes);
    blocks.push({
      html: block,
      kind: labelled
        ? (/(?:impressum|imprint)/iu.test(attributes) ? 'impressum' : 'contact')
        : opening.name === 'footer' ? 'footer' : opening.name === 'address' ? 'address' : kind,
    });
  }
  return blocks;
}

function jsonLdNodes(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) jsonLdNodes(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  out.push(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') jsonLdNodes(nested, out);
  }
  return out;
}

function jsonLdOrganizationCandidates(html = '', pageUrl = '') {
  const out = [];
  for (const opening of scanStartTags(html, 'script')) {
    const type = readAttr(opening.raw, 'type').toLowerCase();
    if (type && type !== 'application/ld+json') continue;
    const close = /<\/script\s*>/gi;
    close.lastIndex = opening.end;
    const closing = close.exec(html);
    if (!closing) continue;
    let parsed;
    try {
      parsed = JSON.parse(decodeEntities(html.slice(opening.end, closing.index).trim()));
    } catch {
      continue;
    }
    for (const node of jsonLdNodes(parsed)) {
      const types = (Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']])
        .map((item) => structuredText(item).split('/').at(-1)?.toLowerCase() || '')
        .filter(Boolean);
      const localBusiness = types.some((item) => item === 'localbusiness' || item.endsWith('localbusiness'));
      const organization = types.some((item) => item === 'organization' || item.endsWith('organization'));
      if (!localBusiness && !organization) continue;
      const addresses = Array.isArray(node.address) ? node.address : [node.address];
      for (const address of addresses) {
        if (typeof address === 'string') {
          for (const candidate of freeTextPostalCandidates(address)) {
            out.push({
              ...candidate,
              sourceUrl: pageUrl,
              sourceKind: localBusiness ? 'jsonld_local_business' : 'jsonld_organization',
            });
          }
          continue;
        }
        if (!address || typeof address !== 'object') continue;
        const addressLocality = structuredText(address.addressLocality);
        const addressCountry = structuredText(address.addressCountry);
        const addressRegion = schemaAddressRegion(address.addressRegion, addressCountry);
        const location = [addressLocality, addressRegion].filter(Boolean).join(', ');
        if (!location && !addressCountry && !address.postalCode) continue;
        out.push({
          location,
          addressLocality,
          addressRegion,
          addressCountry,
          postalCode: structuredText(address.postalCode),
          streetAddress: structuredText(address.streetAddress),
          sourceUrl: pageUrl,
          sourceKind: localBusiness ? 'jsonld_local_business' : 'jsonld_organization',
        });
      }
    }
  }
  return out;
}

function officialTextCandidates(html, pageUrl, pageKind) {
  const out = [];
  for (const block of officialStructuralBlocks(html, pageUrl, pageKind)) {
    for (const candidate of freeTextPostalCandidates(plainOfficialPageText(block.html))) {
      out.push({ ...candidate, sourceUrl: pageUrl, sourceKind: block.kind });
    }
  }
  return out;
}

function officialEvidenceCandidate(candidate) {
  const geography = resolveSourceBackedSwissGeography(candidate);
  if (!geography) return null;
  const fields = sourceBackedSwissGeographyFields(candidate, geography);
  return {
    ...fields,
    sourceUrl: String(candidate.sourceUrl || '').trim(),
    sourceKind: String(candidate.sourceKind || 'official_site').trim(),
  };
}

function normaliseOfficialIdentity(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function officialLocationsCompatible(left, right) {
  for (const field of ['canton', 'postalCode', 'addressLocality', 'streetAddress']) {
    const a = normaliseOfficialIdentity(left?.[field]);
    const b = normaliseOfficialIdentity(right?.[field]);
    if (a && b && a !== b) return false;
  }
  return true;
}

function officialCandidateQuality(candidate) {
  const fields = ['canton', 'postalCode', 'addressLocality', 'streetAddress', 'addressCountry']
    .filter((field) => String(candidate?.[field] || '').trim()).length;
  const structured = String(candidate?.sourceKind || '').startsWith('jsonld_') ? 1 : 0;
  return [fields, structured];
}

function preferOfficialCandidate(left, right) {
  const [leftFields, leftStructured] = officialCandidateQuality(left);
  const [rightFields, rightStructured] = officialCandidateQuality(right);
  return rightFields > leftFields || (rightFields === leftFields && rightStructured > leftStructured)
    ? right
    : left;
}

function normaliseVerifiedEmployerDomain(value = '') {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = normalizeHost(url.hostname);
    const domain = registrableDomain(host);
    return domain && !NON_PLATFORM_HOSTS.has(domain) ? domain : '';
  } catch {
    return '';
  }
}

/**
 * Agencies advertise client workplaces; their own impressum address is not a
 * vacancy location. Keep the exclusion structural and conservative so a page
 * cannot opt itself back in by merely printing a Swiss address.
 *
 * @param {Record<string, any>} context
 * @returns {boolean}
 */
export function isAgencyEmployer(context = {}) {
  if (context.agency === true || context.isAgency === true || context.staffingAgency === true) return true;
  const haystack = [context.name, context.companyName, context.secoEmployerName, context.domain, context.companyKey]
    .filter(Boolean).join(' ');
  return AGENCY_EMPLOYER_RX.test(haystack);
}

/**
 * Extract only the official-site links that can lead to a contact/impressum
 * page. The caller still validates the URL with the public fetch policy before
 * making a request.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} verifiedEmployerDomain
 * @returns {Array<{ url: string, kind: string }>}
 */
export function officialEmployerLocationLinks(html = '', pageUrl = '', verifiedEmployerDomain = '') {
  const domain = normaliseVerifiedEmployerDomain(verifiedEmployerDomain);
  if (!domain) return [];
  const out = [];
  const seen = new Set();
  for (const opening of scanMarkupStartTags(html, 'a')) {
    const rawHref = decodeEntities(readAttr(opening.raw, 'href')).trim();
    if (!rawHref || rawHref.startsWith('#') || /^(?:mailto|tel|javascript):/iu.test(rawHref)) continue;
    let url;
    try {
      url = new URL(rawHref, pageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (registrableDomain(normalizeHost(url.hostname)) !== domain) continue;
      url.hash = '';
    } catch {
      continue;
    }
    const anchorText = plainOfficialPageText(balancedOfficialElement(html, opening, 5000));
    const signal = `${url.pathname} ${url.search} ${anchorText}`;
    if (!OFFICIAL_LOCATION_LINK_RX.test(signal)) continue;
    const normalised = url.toString();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push({ url: normalised, kind: officialPageKind(normalised, /impressum|imprint/iu.test(signal) ? 'impressum' : 'contact') });
  }
  return out;
}

/**
 * Parse the allowed official-site address surfaces from already fetched pages.
 * A result is usable only when all observed address evidence collapses to one
 * physical site; a missing or multi-site proof stays unknown.
 *
 * @param {Array<{ html: string, url: string, kind?: string }>} pages
 * @param {{ verifiedEmployerDomain?: string, platform?: string, name?: string, companyName?: string, secoEmployerName?: string, companyKey?: string, agency?: boolean, isAgency?: boolean, staffingAgency?: boolean }} [context]
 * @returns {{ geography: any|null, candidate: any|null, evidence: any|null, observedLocations: any[], reasonCode: string|null }}
 */
export function resolveOfficialEmployerSiteLocation(pages = [], context = {}) {
  const domain = normaliseVerifiedEmployerDomain(context.verifiedEmployerDomain);
  if (!domain) return { geography: null, candidate: null, evidence: null, observedLocations: [], reasonCode: 'verified_employer_domain_missing' };
  if (context.platform && registrableDomain(normalizeHost(context.platform)) === domain) {
    return { geography: null, candidate: null, evidence: null, observedLocations: [], reasonCode: 'verified_domain_is_shared_platform' };
  }
  if (isAgencyEmployer({ ...context, domain })) {
    return { geography: null, candidate: null, evidence: null, observedLocations: [], reasonCode: 'agency_employer' };
  }

  const parsed = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page || typeof page.html !== 'string' || !page.html) continue;
    let pageDomain = '';
    try { pageDomain = registrableDomain(normalizeHost(new URL(page.url).hostname)); } catch { /* skip malformed page */ }
    if (pageDomain !== domain) continue;
    const candidates = [
      ...jsonLdOrganizationCandidates(page.html, page.url),
      ...officialTextCandidates(page.html, page.url, page.kind),
    ];
    for (const candidate of candidates) {
      const evidence = officialEvidenceCandidate(candidate);
      if (evidence) parsed.push(evidence);
    }
  }

  const groups = [];
  for (const candidate of parsed) {
    const group = groups.find((entry) => officialLocationsCompatible(entry, candidate));
    if (!group) groups.push(candidate);
    else groups[groups.indexOf(group)] = preferOfficialCandidate(group, candidate);
  }
  const observedLocations = groups.map((candidate) => ({
    location: candidate.location,
    canton: candidate.canton,
    addressLocality: candidate.addressLocality || '',
    postalCode: candidate.postalCode || '',
    streetAddress: candidate.streetAddress || '',
  }));
  if (groups.length === 0) {
    return { geography: null, candidate: null, evidence: null, observedLocations, reasonCode: 'official_address_missing' };
  }
  if (groups.length !== 1) {
    return { geography: null, candidate: null, evidence: null, observedLocations, reasonCode: 'multiple_official_sedes' };
  }
  const [selected] = groups;
  const evidence = {
    source: 'employer_site',
    url: selected.sourceUrl,
    type: selected.sourceKind,
    domain,
  };
  const candidate = {
    ...selected,
    locationSource: 'employer_site',
    locationEvidenceUrl: selected.sourceUrl,
    locationEvidenceType: selected.sourceKind,
    locationEvidence: evidence,
  };
  return {
    geography: selected,
    candidate,
    evidence,
    observedLocations,
    reasonCode: null,
  };
}

/**
 * Reconcile the row-level geography drops recorded by validation. This is a
 * report only: it never turns an unknown row into a publishable row.
 *
 * @param {Array<Record<string, any>>|{ records?: Array<Record<string, any>> }} input
 * @returns {{ candidateCount: number, listingRows: number, publishableRows: number, sourceBackedGeographyMissingRows: number, allRowsFiltered: number, records: any[] }}
 */
export function sourceBackedCrawlerBlockReport(input = []) {
  const records = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : [];
  const perRecord = records.map((record) => {
    const history = Array.isArray(record?.validationHistory) ? record.validationHistory : [];
    const observation = record?.runtimeObservation
      || record?.observation
      || history.at(-1)?.runtimeObservation
      || {};
    const listingRows = Number.isFinite(Number(observation.listingCount)) ? Number(observation.listingCount) : 0;
    const publishableRows = Number.isFinite(Number(observation.publishableCount)) ? Number(observation.publishableCount) : 0;
    const geographyMissing = Number(observation.dropCounts?.source_backed_geography_missing) || 0;
    return {
      key: record?.companyKey || record?.crawlerKey || record?.key || record?.companyName || record?.name || '',
      listingRows,
      publishableRows,
      sourceBackedGeographyMissing: geographyMissing,
      allRowsFiltered: listingRows > 0 && publishableRows === 0,
    };
  });
  return {
    candidateCount: perRecord.length,
    listingRows: perRecord.reduce((sum, record) => sum + record.listingRows, 0),
    publishableRows: perRecord.reduce((sum, record) => sum + record.publishableRows, 0),
    sourceBackedGeographyMissingRows: perRecord.reduce((sum, record) => sum + record.sourceBackedGeographyMissing, 0),
    allRowsFiltered: perRecord.filter((record) => record.allRowsFiltered).length,
    records: perRecord,
  };
}
