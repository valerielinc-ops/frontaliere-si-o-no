import { resolveSwissPostalCodePlace } from './swiss-locality-directory.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { findSwissCityInText, isKnownSwissMunicipality } from './target-swiss-locations.mjs';

/**
 * Location values are not all municipality names. Dedicated crawlers also
 * emit facility names, regional labels and language variants. Keep the
 * comparison conservative: only a municipality, a matching postal code, or
 * an exact value can prove that two records describe the same place.
 */
const LOCATION_TOKEN_ALIASES = new Map([
  ['sankt', 'st'],
  ['saint', 'st'],
  ['san', 'st'],
  ['geneva', 'geneve'],
  ['ginevra', 'geneve'],
  ['genf', 'geneve'],
  ['berne', 'bern'],
  ['berna', 'bern'],
  ['bale', 'basel'],
  ['basilea', 'basel'],
  ['freiburg', 'fribourg'],
  ['friburgo', 'fribourg'],
  ['bienne', 'biel'],
  ['coira', 'chur'],
  ['cuira', 'chur'],
  ['lucerne', 'luzern'],
  ['lucerna', 'luzern'],
  ['zurigo', 'zurich'],
]);

function fold(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalTokens(value = '') {
  return fold(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => LOCATION_TOKEN_ALIASES.get(token) || token);
}

function canonicalKeyFromFound(found = '') {
  const tokens = canonicalTokens(found);
  return tokens.length > 0 ? tokens.join(' ') : '';
}

function municipalityKey(value = '', cantonHint = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const found = findSwissCityInText(text, {
    cantonHint,
    allowOfficialLocality: true,
  });
  if (found) return canonicalKeyFromFound(found);
  // Some official aliases, notably Biel, are intentionally absent from the
  // unscoped free-text result because they are ambiguous without a canton.
  // An exact municipality field is still usable for comparison; the caller
  // supplies the source/published canton where that distinction matters.
  return isKnownSwissMunicipality(text) ? canonicalKeyFromFound(text) : '';
}

// Dedicated source fields use these separators for a list of sites. Split
// before calling findSwissCityInText(), whose contract intentionally returns
// the first matching municipality in free text.
const CRAWLER_LOCATION_LIST_SEPARATOR_RE = /\s*(?:\/|,|;|\||&|\r?\n)\s*/u;

/**
 * Resolve the first concrete locality in a source field. A list-separated
 * field naming multiple concrete municipalities is deliberately ambiguous;
 * choosing its first token would turn a multi-site region into a false
 * contradiction.
 */
export function canonicalCrawlerLocationKey(value = '', cantonHint = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  const listParts = text.split(CRAWLER_LOCATION_LIST_SEPARATOR_RE).map((part) => part.trim()).filter(Boolean);
  if (listParts.length > 1) {
    const keys = [...new Set(listParts.map((part) => municipalityKey(part, cantonHint)).filter(Boolean))];
    if (keys.length > 1) return '';
    if (keys.length === 1) return keys[0];
  }

  return municipalityKey(text, cantonHint);
}

function normalizedRaw(value = '') {
  return fold(value)
    .replace(/\b(?:ch|che|switzerland|schweiz|suisse|svizzera)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mentionsLocationKey(value, locationKey) {
  const valueTokens = canonicalTokens(value);
  const wanted = String(locationKey || '').split(' ').filter(Boolean);
  if (!valueTokens.length || !wanted.length || wanted.length > valueTokens.length) return false;
  return valueTokens.some((_, index) => wanted.every((token, offset) => valueTokens[index + offset] === token));
}

function postalPlace(postalCode = '') {
  return resolveSwissPostalCodePlace(String(postalCode || '').trim());
}

function samePostalPlace(left, right) {
  return Boolean(left && right && left.canton === right.canton && left.locality === right.locality);
}

/**
 * Compare a crawler's source locality with the locality emitted by the
 * assembled dataset.
 *
 * `same` means the source-backed evidence proves one place, `different` means
 * both sides identify different concrete places, and `unknown` means the
 * source does not contain enough locality evidence to adjudicate the row.
 * Unknown is intentionally not a bug verdict: a regional or facility label
 * cannot prove that the assembler moved a vacancy to the wrong municipality.
 */
export function compareCrawlerPublishedLocation({
  sourceLocation = '',
  publishedLocation = '',
  sourcePostalCode = '',
  publishedPostalCode = '',
  sourceCanton = '',
  publishedCanton = '',
} = {}) {
  const source = String(sourceLocation || '').trim();
  const published = String(publishedLocation || '').trim();
  if (!source || !published) return 'unknown';

  const sourcePostal = postalPlace(sourcePostalCode);
  const publishedPostal = postalPlace(publishedPostalCode);
  const sourceKey = canonicalCrawlerLocationKey(source, sourceCanton);
  const publishedKey = canonicalCrawlerLocationKey(published, publishedCanton);

  // Do not let a Swiss homonym inside a foreign compound (for example
  // `Baden-Württemberg`) certify the published locality. If both sides are
  // explicitly foreign, the location audit is not the authority that decides
  // between those foreign places; retain the conservative unknown result.
  const sourceForeign = isLocationExplicitlyForeign(source);
  const publishedForeign = isLocationExplicitlyForeign(published);
  if (sourceForeign && !publishedForeign) return 'different';
  // Keep the foreign guard symmetric when the source has concrete Swiss
  // evidence. An explicitly foreign published city is a rewrite, while a
  // regional/facility label without a municipality or postal place remains
  // unknown rather than becoming a hard-fail by association.
  if (publishedForeign && !sourceForeign && (sourceKey || sourcePostal)) return 'different';

  if (normalizedRaw(source) === normalizedRaw(published)) return 'same';

  if (sourcePostal && publishedPostal && samePostalPlace(sourcePostal, publishedPostal)) return 'same';

  if (sourceKey && publishedKey && sourceKey === publishedKey) return 'same';

  if (sourcePostal && publishedKey) {
    const sourcePostalKey = canonicalCrawlerLocationKey(sourcePostal.locality, sourcePostal.canton);
    if (sourcePostalKey === publishedKey) return 'same';
    // Some sources write a sub-locality plus its parent municipality, e.g.
    // `Ibach-Schwyz`, while the public schema keeps the parent (`Schwyz`).
    // Require the source CAP, the published canton and an unambiguous
    // parent-name token; never use a canton alone as a rescue.
    if (sourcePostal.canton === String(publishedCanton || '').trim().toUpperCase()
      && !CRAWLER_LOCATION_LIST_SEPARATOR_RE.test(source)
      && mentionsLocationKey(source, publishedKey)) {
      return 'same';
    }
  }

  if (publishedPostal && sourceKey) {
    const publishedPostalKey = canonicalCrawlerLocationKey(publishedPostal.locality, publishedPostal.canton);
    if (publishedPostalKey === sourceKey) return 'same';
  }

  if (sourceKey && publishedKey) return 'different';

  // A concrete postal locality on one side is enough to prove a contradiction
  // against a different concrete locality on the other side, even when the
  // source itself is a facility label that has no municipality token.
  if (sourcePostal && publishedKey) return 'different';
  if (publishedPostal && sourceKey) return 'different';

  return 'unknown';
}

/**
 * Resolve the canton for the audit's BFS check using an authoritative postal
 * locality when it agrees with the published city. The generic city resolver
 * remains the fallback for rows without a usable postal address.
 */
export function cantonFromPublishedPostalCode({
  city = '',
  postalCode = '',
  storedCanton = '',
} = {}) {
  const place = postalPlace(postalCode);
  if (!place || compareCrawlerPublishedLocation({
    sourceLocation: place.locality,
    publishedLocation: city,
    sourcePostalCode: postalCode,
    sourceCanton: place.canton,
    publishedCanton: storedCanton,
  }) !== 'same') return '';
  return place.canton;
}
