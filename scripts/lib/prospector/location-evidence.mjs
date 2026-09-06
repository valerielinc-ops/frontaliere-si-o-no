import {
  TEXT_RESCUE_AMBIGUOUS_TOKENS,
  inferSwissTargetCanton,
  isCantonRelevant,
  isKnownSwissMunicipality,
  isKnownSwissMunicipalityInCanton,
  isLiechtensteinPostalCode,
  normalizeSwissTargetLocationText,
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

// `normalizeCantonCode()` intentionally accepts municipalities and curated
// city aliases because it is a free-text helper. `addressRegion`, however, is
// a subdivision field: accepting `Buchs` there as SG manufactures canton
// evidence from a city name. Keep a narrow, versioned list of the 26 official
// canton names (and their official-language spellings) for structured region
// slots.
const OFFICIAL_CANTON_NAMES = Object.freeze({
  AG: ['aargau', 'argovie', 'argovia'],
  AI: ['appenzell innerrhoden', 'appenzell rhodes interieures', 'appenzello interno'],
  AR: ['appenzell ausserrhoden', 'appenzell rhodes exterieures', 'appenzello esterno'],
  BE: ['bern', 'berne', 'berna'],
  BL: ['basel landschaft', 'bale campagne', 'basilea campagna'],
  BS: ['basel stadt', 'bale ville', 'basilea citta'],
  FR: ['fribourg', 'freiburg', 'friburgo'],
  GE: ['geneve', 'genf', 'ginevra', 'geneva'],
  GL: ['glarus', 'glaris', 'glarona'],
  GR: ['graubunden', 'grisons', 'grigioni', 'grischun'],
  JU: ['jura', 'giura'],
  LU: ['luzern', 'lucerne', 'lucerna'],
  NE: ['neuchatel', 'neuenburg'],
  NW: ['nidwalden', 'nidwald', 'nidvaldo'],
  OW: ['obwalden', 'obwald', 'obvaldo'],
  SG: ['st gallen', 'saint gall', 'san gallo', 'sankt gallen'],
  SH: ['schaffhausen', 'schaffhouse', 'sciaffusa'],
  SO: ['solothurn', 'soleure', 'soletta'],
  SZ: ['schwyz', 'svitto'],
  TG: ['thurgau', 'thurgovie', 'turgovia'],
  TI: ['ticino', 'tessin'],
  UR: ['uri'],
  VD: ['vaud', 'waadt'],
  VS: ['valais', 'wallis', 'vallese'],
  ZG: ['zug', 'zoug', 'zugo'],
  ZH: ['zurich', 'zuerich', 'zurigo'],
});

function normalizeOfficialCantonCode(value) {
  const normalized = normalizeSwissTargetLocationText(value);
  if (!normalized) return '';
  const code = normalized.toUpperCase();
  if (Object.hasOwn(OFFICIAL_CANTON_NAMES, code)) return code;
  const isoCode = /^CH\s+([A-Z]{2})$/.exec(code)?.[1] || '';
  if (Object.hasOwn(OFFICIAL_CANTON_NAMES, isoCode)) return isoCode;
  for (const [candidate, names] of Object.entries(OFFICIAL_CANTON_NAMES)) {
    if (names.includes(normalized)) return candidate;
  }
  return '';
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
  return !codes.some(({ code }) => normalizeOfficialCantonCode(code)
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
  const evidence = /** @type {any} */ (value && typeof value === 'object'
    ? value
    : { location: value, addressCountry });
  const location = String(evidence.location || evidence.addressLocality || '').replace(/\s+/g, ' ').trim();
  const country = String(evidence.addressCountry || evidence.country || addressCountry || '').trim();
  const addressLocality = String(evidence.addressLocality || '').replace(/\s+/g, ' ').trim();
  const addressRegion = String(evidence.addressRegion || '').replace(/\s+/g, ' ').trim();
  if (!location) return null;
  // Municipality names have international homonyms (e.g. Provence VD). An
  // explicit terminal country segment from the source outranks that fuzzy
  // token match. Multi-location rows that also name Switzerland remain valid.
  if (isExplicitlyForeign(location, country) || hasUncorroboratedForeignSubdivision(location)) return null;
  const structuredCanton = normalizeOfficialCantonCode(addressRegion);
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
  const municipalityCantons = swissMunicipalityCantons(locality);
  if (!explicitCanton && municipalityCantons.length > 1) return null;
  if (explicitCanton && addressLocality
    && !isKnownSwissMunicipalityInCanton(addressLocality, explicitCanton)) return null;
  const canton = explicitCanton || inferSwissTargetCanton(withoutCodes);
  if (!canton || (!explicitCanton && !isCantonRelevant(withoutCodes, canton, { includeBorderProximity: false }))) return null;
  const geography = { location, canton };
  if (country) geography.addressCountry = country;
  return geography;
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
  return [
    String(candidate?.location || '').trim(),
    String(candidate?.addressCountry || candidate?.country || '').trim(),
    String(candidate?.addressLocality || '').trim(),
    String(candidate?.addressRegion || '').trim(),
    String(candidate?.postalCode || '').trim(),
    String(candidate?.streetAddress || '').trim(),
  ].join('\u0000');
}

/**
 * Drop candidates that repeat a place already present, keeping the first
 * occurrence and the original objects untouched. No filtering, no
 * normalisation: this is deduplication, the grading stays with the voter.
 *
 * @param {any[]} candidates
 * @returns {any[]}
 */
export function dedupeLocationCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = locationEvidenceKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const seen = new Set();
  return candidates
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
    .filter((candidate) => {
      if (!candidate.location && !candidate.addressCountry) return false;
      const key = locationEvidenceKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * @param {LocationEvidenceCandidate[]} candidates
 * @returns {{
 *   geography: { location: string, canton: string, addressCountry?: string } | null,
 *   explicitlyForeign: boolean,
 *   candidate: LocationEvidenceCandidate,
 * }}
 */
export function evaluateSourceBackedSwissGeography(candidates = []) {
  let explicitlyForeign = false;
  for (const candidate of candidates) {
    const location = String(candidate?.location || '').trim();
    const country = String(candidate?.addressCountry || candidate?.country || '').trim();
    const region = String(candidate?.addressRegion || '').trim();
    if (isExplicitlyForeign(location, country)
      || hasUncorroboratedForeignSubdivision(location)
      || (region && !normalizeOfficialCantonCode(region))
      || isKnownForeignSubdivision(region)) {
      explicitlyForeign = true;
      continue;
    }
    const geography = resolveSourceBackedSwissGeography(candidate, country);
    if (geography) return { geography, explicitlyForeign, candidate };
  }
  return { geography: null, explicitlyForeign, candidate: EMPTY_LOCATION_EVIDENCE };
}

/** @returns {{ geography: null, explicitlyForeign: false, candidate: LocationEvidenceCandidate }} */
function noGeography() {
  return { geography: null, explicitlyForeign: false, candidate: EMPTY_LOCATION_EVIDENCE };
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
 * The postal locations an employer prints on EVERY one of its pages — its own
 * seat, in other words, not the workplace of any single vacancy. Measured on
 * physioswiss.ch on 2026-09-06: six detail pages, `3013 Bern` (the
 * association's seat) on all six, one further pair per page and each of them
 * the vacancy's actual town.
 *
 * Pages with no pair at all are excluded from the intersection: they say
 * nothing about what is boilerplate, and counting them would empty the set and
 * let the seat through as if it were the workplace.
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
  const [first, ...rest] = withEvidence;
  return [...first].filter((location) => rest.every((page) => page.has(location)));
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
 * @param {{ postalTextCandidates?: LocationEvidenceCandidate[], boilerplatePostalLocations?: string[]|null }} [pageContext]
 *   free-text evidence for THIS page plus the employer's boilerplate, both
 *   produced by the caller that saw the other pages. Absent (the default), the
 *   free-text tier stays off and behaviour is exactly what it was.
 * @returns {{
 *   geography: { location: string, canton: string, addressCountry?: string } | null,
 *   explicitlyForeign: boolean,
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
    return { geography: null, explicitlyForeign: true, candidate: EMPTY_LOCATION_EVIDENCE };
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
  return textDecision.geography ? textDecision : listingDecision;
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
