/**
 * Resolve a job canton without discarding source-backed ambiguity evidence.
 *
 * `addressLocality` is intentionally reduced to a bare municipality for
 * structured data, but several Swiss municipalities are homonyms across
 * cantons (`Buchs`, `Reinach`, `Gossau`, ...). Inferring from that field alone
 * lets the first canton in the lookup table overwrite a valid per-job canton.
 * The source location and crawler canton are stronger evidence when they
 * agree; a location marker that conflicts with the crawler is deliberately
 * not allowed to hide the conflict at assembly time.
 *
 * @param {{cityText?: string, locationText?: string, crawlerCanton?: string, sourceLocationCanton?: string}} input
 * @returns {string}
 */
import { cantonNamedByLocation } from './job-location-display.mjs';
import {
  inferAnyCanton,
  isKnownSwissMunicipalityInCanton,
  isTargetCanton,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';

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
