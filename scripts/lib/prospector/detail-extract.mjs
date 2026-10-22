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

import { extractDetailFields, isSufficientVacancyDescription, textOf } from './extract.mjs';
import { dedupeLocationCandidates } from './location-evidence.mjs';
import { extractPageExecutiveDetailFields } from './pageexecutive-detail.mjs';
import { extractUmantisDetailFields, umantisDetailFallbackUrl } from './umantis-detail.mjs';
import { normalizeSwissCantonCode } from '../target-swiss-locations.mjs';

function normalizedLabel(value) {
  return textOf(String(value || '').replace(/&nbsp;/gi, ' '))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read the first paragraph after an exact heading in a detail page.
 *
 * Some employer pages include both the vacancy's workplace and the company's
 * head office in their structured data and footer. A spec may name the exact
 * heading for the per-vacancy workplace, so that label can be preferred over
 * unrelated company addresses.
 *
 * @param {string} html
 * @param {string} label
 * @returns {string}
 */
export function extractLabelledDetailValue(html = '', label = '') {
  const wanted = normalizedLabel(label);
  if (!wanted) return '';
  const source = String(html || '');
  const headings = /<h([1-6])\b[^>]*>([\s\S]{0,500}?)<\/h\1>/gi;
  let heading;
  while ((heading = headings.exec(source))) {
    if (normalizedLabel(heading[2]) !== wanted) continue;
    const afterHeading = source.slice(headings.lastIndex);
    const nextHeading = /<h[1-6]\b/i.exec(afterHeading);
    const section = afterHeading.slice(0, nextHeading ? nextHeading.index : 1500);
    const paragraph = /<p\b[^>]*>([\s\S]{1,500}?)<\/p>/i.exec(section);
    const value = paragraph ? textOf(paragraph[1].replace(/&nbsp;/gi, ' ')) : '';
    if (value) return value;
  }
  return '';
}

function labelledLocationEvidence(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  // A choice of broad work areas does not identify one workplace. Refuse it
  // explicitly so the page-wide company address cannot fall back in.
  if (/\b(?:oder|or)\b|\s\/\s/i.test(raw)) return null;
  const workplace = raw.replace(/\s+Einsatzgebiet\b[\s\S]*$/i, '').trim();
  const suffix = /^(.*?)\s*\(([A-Za-z]{2,3})\)(?:\s+.*)?$/.exec(workplace);
  const addressRegion = normalizeSwissCantonCode(suffix?.[2] || '');
  const addressLocality = String(suffix?.[1] || '').trim();
  if (!addressRegion || !addressLocality) return { location: raw };
  return {
    location: addressLocality,
    addressLocality,
    addressRegion,
    addressCountry: 'CH',
  };
}

/**
 * @param {{ platform?: string }} spec
 * @param {string} html
 * @param {string} url
 * @param {{ detailExtractor?: (html: string, url: string, opts?: { recordUrl?: string, recordTitle?: string }) => any, recordUrl?: string, recordTitle?: string }} [opts]
 * @returns {any}
 */
export function extractRuntimeDetailFields(spec, html, url, opts = {}) {
  const tenantExtractor = typeof opts.detailExtractor === 'function' ? opts.detailExtractor : null;
  const base = tenantExtractor
    || (spec?.platform === 'pageexecutive.com'
      ? extractPageExecutiveDetailFields
      : extractDetailFields);
  const detail = base(html, url, {
    recordUrl: opts.recordUrl,
    recordTitle: opts.recordTitle,
  });
  const labelledLocation = extractLabelledDetailValue(html, spec?.detailLocationLabel);
  if (labelledLocation) {
    // The named source heading describes the vacancy's workplace. Replace the
    // page-wide address candidates so a company address in JSON-LD/footer
    // cannot outrank it during the shared Swiss geography resolution.
    const evidence = labelledLocationEvidence(labelledLocation);
    if (!evidence) {
      detail.authoritativeLocationConflict = true;
      return detail;
    }
    detail.location = evidence.location;
    detail.locationCandidates = [evidence];
    detail.addressLocality = evidence.addressLocality || '';
    detail.addressRegion = evidence.addressRegion || '';
    detail.addressCountry = evidence.addressCountry || '';
    detail.country = evidence.addressCountry || '';
    detail.postalCode = '';
    detail.streetAddress = '';
  }
  if (spec?.platform !== 'umantis.com') return detail;
  // A tenant extractor read the very same page: its output is the whole
  // verdict, EMPTY FIELDS INCLUDED. An empty location means "nothing here
  // passed my verification", not "nobody looked yet", and an empty description
  // means the vacancy boundary this tenant requires was not on the page. The
  // generic re-derivation applies none of that verification, so running it on
  // top silently undoes it: measured on 2026-09-06, `extractApleonaDetailFields`
  // over a real Umantis-served detail page had `location`, `locationCandidates`
  // and `description` all repopulated — its canton gate and its mandatory
  // vacancy-specific section bypassed. The two former guards
  // (`locationGateRejected`, non-empty `locationCandidates`) could not express
  // that: no contract obliged a tenant to raise the flag, none of the four
  // tenant extractors in this repo raises it when it simply found nothing, and
  // the description branch had no guard at all.
  //
  // A tenant that DOES want the generic chain composes it explicitly, by
  // calling this function without a `detailExtractor` — which is exactly what
  // `recruitingapp-2649-job-parser.mjs` does inside its own extractor.
  if (tenantExtractor) return detail;

  const umantisDetail = extractUmantisDetailFields(html);
  if (isSufficientVacancyDescription(umantisDetail.description)) {
    detail.description = umantisDetail.description;
  }
  if (!detail.locationCandidates?.length
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
  const rowHasConcreteLocationEvidence = Boolean(
    row.location || row.addressLocality || row.locationCandidates?.length,
  );
  const projectedEvidence = evidence.sourceTitleAlternatives && rowHasConcreteLocationEvidence ? null : evidence;
  const evidenceCandidates = projectedEvidence
    ? Array.isArray(projectedEvidence.locationCandidates)
      ? projectedEvidence.locationCandidates
      : [projectedEvidence]
    : [];
  return {
    location: row.location || projectedEvidence?.location || '',
    addressLocality: row.addressLocality || projectedEvidence?.addressLocality || '',
    addressRegion: row.addressRegion || projectedEvidence?.addressRegion || '',
    addressCountry: row.addressCountry || projectedEvidence?.addressCountry || '',
    postalCode: row.postalCode || projectedEvidence?.postalCode || '',
    streetAddress: row.streetAddress || projectedEvidence?.streetAddress || '',
    // Folding the same evidence twice must not grow the row: the crawler and
    // the synthesiser both apply this function, and a validator run that
    // re-applies it over an already-folded row would otherwise publish the
    // same place twice as separate evidence. Identity is the address, so
    // `f(f(row, e), e)` equals `f(row, e)`.
    locationCandidates: dedupeLocationCandidates([...(row.locationCandidates || []), ...evidenceCandidates]),
  };
}
