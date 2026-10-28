/**
 * Resolve a job canton without discarding source-backed ambiguity evidence.
 *
 * `addressLocality` is intentionally reduced to a bare municipality for
 * structured data, but several Swiss municipalities are homonyms across
 * cantons (`Buchs`, `Reinach`, `Gossau`, ...). Inferring from that field alone
 * lets the first canton in the lookup table overwrite a valid per-job canton.
 * The source location and crawler canton are stronger evidence when they
 * agree; a location marker that conflicts with the crawler is deliberately
 * not allowed to hide the conflict at assembly time. When the source-backed
 * locality itself carries a validated canton marker, it is more specific than
 * a stale listing-level location marker and wins before the crawler stamp.
 *
 * @param {{cityText?: string, locationText?: string, crawlerCanton?: string, sourceLocationCanton?: string}} input
 * @returns {string}
 */
import { cantonNamedByLocation } from './job-location-display.mjs';
import { officialLocalityPostalCode } from './swiss-locality-directory.mjs';
import {
  inferAnyCanton,
  isKnownSwissMunicipalityInCanton,
  isTargetCanton,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

/**
 * Whether a source location names the published locality as a complete token
 * sequence. Source rows often carry canton/country metadata or a spelling
 * variant ("Brügg BE" → "Brugg"), while assembly keeps only the canonical
 * locality. Token matching preserves that evidence without accepting a
 * substring such as `Au` inside an unrelated word.
 *
 * @param {unknown} sourceLocation
 * @param {unknown} city
 * @returns {boolean}
 */
export function sourceLocationContainsCity(sourceLocation, city) {
  const foldTokens = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sourceTokens = foldTokens(sourceLocation);
  const cityTokens = foldTokens(city);
  if (sourceTokens.length === 0 || cityTokens.length === 0 || cityTokens.length > sourceTokens.length) return false;
  return sourceTokens.some((_, index) => cityTokens.every((token, offset) => sourceTokens[index + offset] === token));
}

export function inferCantonFromJobEvidence({
  cityText = '',
  locationText = '',
  crawlerCanton = '',
  sourceLocationCanton = '',
} = {}) {
  const city = String(cityText || '').trim();
  const location = String(locationText || '').trim();
  const crawler = String(crawlerCanton || '').trim().toUpperCase();
  const sourceCandidate = String(sourceLocationCanton || '').trim().toUpperCase();
  const source = isTargetCanton(sourceCandidate) ? sourceCandidate : '';
  const encoded = cantonNamedByLocation(location);
  const cityEncoded = cantonNamedByLocation(city);

  // `addressLocality` is the source-backed locality for the same stable row.
  // A validated explicit marker there must outrank a stale `location` marker
  // and the crawler's default/HQ stamp (e.g. Rüti ZH vs Lachen SZ). Do not let
  // an arbitrary suffix win: the municipality check keeps malformed/company
  // text and unknown markers fail-closed.
  if (
    cityEncoded
    && isKnownSwissMunicipalityInCanton(city, cityEncoded)
  ) {
    return cityEncoded;
  }

  // An explicit source marker is safe only when it agrees with the crawler's
  // own canton. A disagreement is a real data-quality conflict, not a reason
  // for a downstream repair to choose a winner silently.
  if (encoded && (!crawler || encoded === crawler)) return encoded;

  // Some source adapters retain the canton parsed from the posting's own
  // address/state even though the shared locality sanitizer later reduces
  // `addressLocality` to the bare municipality. Keep that independent,
  // per-posting evidence available for real homonyms such as Seewen (SO/SZ).
  // A source marker that conflicts with the crawler stamp is not a safe
  // winner: leave the conflict visible to the existing inference rules.
  if (source && (!crawler || source === crawler) && (!encoded || encoded === source)) {
    return source;
  }

  const locality = city || swissCityFromLocationField(location) || location;
  const inferred = inferAnyCanton(city || location);

  // A bare homonym is not enough to overrule per-job source evidence. Require
  // the crawler canton to be a real canton in which that municipality exists;
  // clear mismatches such as Moutier/BE still flow to generic inference.
  // The official locality registry contains source labels that are not BFS
  // municipalities (and bare homonyms such as `Au`). With a per-posting
  // crawler canton they become independently disambiguated evidence; do not
  // let the foreign-country heuristic or an arbitrary BFS-first canton win.
  // A transferred municipality can remain listed under both the old and new
  // canton with the same postal code (Moutier/BE and JU). That directory row
  // does not disambiguate the source, so it must not overrule the current BFS
  // municipality inference; genuinely distinct official localities such as
  // Seewen/SZ versus Seewen/SO retain their source-backed evidence.
  const crawlerLocalityPostalCode = officialLocalityPostalCode(locality, crawler);
  const inferredLocalityPostalCode = inferred
    ? officialLocalityPostalCode(locality, inferred)
    : '';
  const samePostalLocalityAcrossCantons = Boolean(
    inferred
    && crawlerLocalityPostalCode
    && inferredLocalityPostalCode
    && crawlerLocalityPostalCode === inferredLocalityPostalCode,
  );
  if (
    crawler
    && (!inferred || inferred !== crawler)
    && !samePostalLocalityAcrossCantons
    && isKnownSwissMunicipalityInCanton(locality, crawler, { allowOfficialLocality: true })
  ) {
    return crawler;
  }

  return inferred;
}
