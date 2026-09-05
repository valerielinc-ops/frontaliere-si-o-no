/**
 * Detail-page field extraction, shared by the runtime crawler and the
 * validator.
 *
 * The gate only means something if validation grades the fields the runtime
 * would actually publish. Until this module existed the two disagreed:
 * `spec-crawler.mjs` merged the tenant-specific Umantis extractor on top of
 * the generic cascade, while `validate.mjs` graded with the generic cascade
 * alone. Every Umantis tenant whose layout the generic cascade cannot read was
 * therefore graded `contentful: false` / `sourceBackedLocation: false` and
 * blocked forever — measured on 2026-09-05: recruitingapp-2924 (Gesundheits-
 * zentrum Fricktal) publishes 6 vacancies with source-backed Rheinfelden AG
 * geography and 1.2-1.9 KB descriptions, while its last validation reported
 * 0% on both. One extractor, two callers: the disagreement cannot come back.
 */

import { extractDetailFields, isSufficientVacancyDescription } from './extract.mjs';
import { extractPageExecutiveDetailFields } from './pageexecutive-detail.mjs';
import { extractUmantisDetailFields, umantisDetailFallbackUrl } from './umantis-detail.mjs';

/**
 * @param {{ platform?: string }} spec
 * @param {string} html
 * @param {string} url
 * @param {{ detailExtractor?: (html: string, url: string) => any }} [opts]
 * @returns {any}
 */
export function extractRuntimeDetailFields(spec, html, url, opts = {}) {
  const base = typeof opts.detailExtractor === 'function'
    ? opts.detailExtractor
    : spec?.platform === 'pageexecutive.com'
      ? extractPageExecutiveDetailFields
      : extractDetailFields;
  const detail = base(html, url);
  if (spec?.platform !== 'umantis.com') return detail;

  const umantisDetail = extractUmantisDetailFields(html);
  if (isSufficientVacancyDescription(umantisDetail.description)) {
    detail.description = umantisDetail.description;
  }
  // A tenant-specific extractor that already rejected a verified candidate
  // (e.g. Apleona's canton-suffix gate) must not have that rejection silently
  // overridden by the generic Umantis re-derivation, which applies none of
  // that tenant's verification.
  if (!detail.locationGateRejected
    && !detail.locationCandidates?.length
    && umantisDetail.locationCandidates?.length) {
    detail.locationCandidates = umantisDetail.locationCandidates;
    const [candidate] = umantisDetail.locationCandidates;
    detail.location = candidate.location;
    detail.addressCountry = candidate.addressCountry;
  }
  return detail;
}

/**
 * The detail URL to retry when the first one does not serve the page.
 *
 * Umantis answers some tenants' `/Vacancies/<id>/Description/1` with a 302 to
 * a session-bound URL. The runtime already retried on the tenant-specific
 * fallback; the validator did not, so it graded those pages `reachable: false`
 * and scored the whole spec near zero — recruitingapp-2924 (Gesundheitszentrum
 * Fricktal) graded 0.10 on 2026-09-05 while the runtime published 6 vacancies
 * from the very same URLs. Same rule, both callers.
 *
 * @param {{ platform?: string }} spec
 * @param {number|string|undefined} status HTTP status the first attempt returned
 * @param {string} url
 * @returns {string} the URL to retry, or '' when there is nothing to retry
 */
export function runtimeDetailFallbackUrl(spec, status, url) {
  if (spec?.platform !== 'umantis.com') return '';
  const code = Number(status);
  if (!(code >= 300 && code < 400)) return '';
  return umantisDetailFallbackUrl(url) || '';
}

/**
 * The location fields a listing row carries once the platform's own listing
 * evidence is folded in.
 *
 * On Umantis the vacancy's location lives in the listing row, not on the
 * detail page, and both the runtime and the synthesiser have to fold it in the
 * same way — otherwise the validator grades rows poorer than the ones the
 * crawler will publish. Row values always win: the listing evidence only fills
 * what the generic extraction left empty.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>|undefined} evidence
 * @returns {Record<string, any>} the fields to spread over the row, empty when there is no evidence
 */
export function listingEvidenceFields(row = {}, evidence) {
  if (!evidence) return {};
  return {
    location: row.location || evidence.location || '',
    addressLocality: row.addressLocality || evidence.addressLocality || '',
    addressRegion: row.addressRegion || evidence.addressRegion || '',
    addressCountry: row.addressCountry || evidence.addressCountry || '',
    postalCode: row.postalCode || evidence.postalCode || '',
    streetAddress: row.streetAddress || evidence.streetAddress || '',
    locationCandidates: [...(row.locationCandidates || []), evidence],
  };
}
