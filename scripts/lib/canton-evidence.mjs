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
