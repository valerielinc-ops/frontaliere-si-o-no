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
 * @param {{cityText?: string, locationText?: string, crawlerCanton?: string}} input
 * @returns {string}
 */
import { cantonNamedByLocation } from './job-location-display.mjs';
import {
  inferAnyCanton,
  isKnownSwissMunicipalityInCanton,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

export function inferCantonFromJobEvidence({ cityText = '', locationText = '', crawlerCanton = '' } = {}) {
  const city = String(cityText || '').trim();
  const location = String(locationText || '').trim();
  const crawler = String(crawlerCanton || '').trim().toUpperCase();
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

  const locality = city || swissCityFromLocationField(location) || location;
  const inferred = inferAnyCanton(city || location);

  // A bare homonym is not enough to overrule per-job source evidence. Require
  // the crawler canton to be a real canton in which that municipality exists;
  // clear mismatches such as Moutier/BE still flow to generic inference.
  if (
    crawler
    && inferred
    && inferred !== crawler
    && isKnownSwissMunicipalityInCanton(locality, crawler)
  ) {
    return crawler;
  }

  return inferred;
}
