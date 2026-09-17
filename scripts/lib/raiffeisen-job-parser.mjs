#!/usr/bin/env node
/**
 * Raiffeisen Schweiz job parser — CH-wide, Prospective.ch medium 1950.
 *
 * Raiffeisen Schweiz is the national cooperative bank group; all ~225
 * autonomous regional Raiffeisen banks (Raiffeisenbanken) post their
 * vacancies through the SAME shared Prospective.ch career center:
 *
 *   https://jobs.raiffeisen.ch/  (careercenter/1950 SPA front-end)
 *   API: https://ohws.prospective.ch/public/v1/medium/1950/jobs?lang=de
 *
 * ── Relationship to raiffeisen-vc-job-parser.mjs ────────────────────────
 * `scripts/update-raiffeisen-vc-jobs.mjs` already crawls jobs.raiffeisen.ch,
 * but narrowly scoped to ONE regional bank (Banca Raiffeisen Vedeggio
 * Cassarate, Ticino) via HTML scraping of that bank's own careers page.
 * This factory instead pulls the full national feed (all regional banks,
 * ~210 postings, all 26 cantons) directly from the shared medium API.
 *
 * To avoid emitting duplicate postings for the same physical jobs, this
 * parser explicitly EXCLUDES any listing that belongs to Banca Raiffeisen
 * Vedeggio Cassarate (matched via `isVedeggioCassarateListing()` below,
 * checked against the raw Prospective listing's title/introduction/directlink
 * — the VC crawler's own detail-page enrichment is intentionally left as
 * the sole owner of those postings). This is a clear non-overlapping
 * partition of the same underlying ATS, NOT a second parallel VC crawler.
 *
 * Renaming/generalizing the existing raiffeisen-vc crawler in place was
 * considered (and would also work) but was assessed too risky to do safely
 * in one pass here: its companyKey (`banca-raiffeisen-vedeggio-cassarate`)
 * is threaded through ~15 live production data/state files (translation
 * cache, adapter registry, per-crawler job slices, expired-job archive,
 * historical snapshots, a dedicated test file, its own GitHub Actions
 * workflow) that would all need a coordinated migration. A fresh,
 * explicitly-partitioned crawler achieves full CH-wide coverage with zero
 * risk to that existing production pipeline.
 *
 * Canton and Swiss scope are resolved per posting from the source location
 * and region with `isTargetSwissLocation()` + `inferAnyCanton()`, covering
 * all 26 cantons. Unresolved locations are dropped; the national feed never
 * receives a headquarters city, canton, postal code or street as a fallback.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import { getCantonPostalFallback } from './canton-postal-fallback.mjs';

export const RAIFFEISEN_KEY = 'raiffeisen';
export const RAIFFEISEN_COMPANY_NAME = 'Raiffeisen';
export const RAIFFEISEN_COMPANY_DOMAIN = 'raiffeisen.ch';

/**
 * True when a raw Prospective listing belongs to Banca Raiffeisen Vedeggio
 * Cassarate — the one regional bank already owned by the dedicated
 * `raiffeisen-vc` crawler. Matched on the listing's own text (title,
 * intro/benefits/tasks, directlink) rather than region/canton, since other
 * legitimate Ticino-based Raiffeisen banks (tagged region "Tessin" too)
 * must still be included here.
 *
 * @param {object} listing - Raw Prospective listing object
 * @returns {boolean}
 */
function isVedeggioCassarateListing(listing) {
  let haystack = '';
  try {
    haystack = JSON.stringify(listing || {}).toLowerCase();
  } catch {
    return false;
  }
  return haystack.includes('vedeggio') || haystack.includes('cassarate');
}

const SWISS_COUNTRY_VALUES = new Set(['ch', 'switzerland', 'schweiz', 'suisse', 'svizzera']);

function normalizeSourceValue(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sourceRegion(listing) {
  const szas = listing?.szas || {};
  return normalizeSourceValue(
    szas['sza_location.region']
      || szas['sza_workplace.region']
      || szas.sza_region
      || listing?.region
      || '',
  );
}

function sourceCountry(listing) {
  const szas = listing?.szas || {};
  return normalizeSourceValue(
    szas['sza_location.country']
      || szas['sza_workplace.country']
      || szas.sza_country
      || listing?.country
      || '',
  );
}

function sourceLocation(listing) {
  const szas = listing?.szas || {};
  const city = normalizeSourceValue(szas['sza_location.city'] || szas['sza_workplace.city']);
  if (city) return city;

  // A small number of national listings omit the dotted city field but keep
  // the source's flat location label, e.g. "Rothenburg, Schweiz". Strip only
  // the source country suffix; do not invent a city from the HQ.
  const flat = normalizeSourceValue(szas.sza_location);
  if (!flat) return '';
  const withoutCountry = flat.replace(/,?\s*(?:CH|Switzerland|Schweiz|Suisse|Svizzera)\s*$/i, '').trim();
  const postalCity = withoutCountry.match(/\b\d{4}(?:\s+|-(?=\p{L}))(?<city>\p{L}[^,]*)/u);
  if (postalCity?.groups?.city) return normalizeSourceValue(postalCity.groups.city);
  return normalizeSourceValue(withoutCountry.split(',')[0]);
}

/**
 * Resolve one Raiffeisen listing using only its own source-backed location.
 * Region is included because the Prospective feed contains legitimate
 * multi-site labels and occasional records without a city field.
 */
export function resolveRaiffeisenLocation(listing) {
  const location = sourceLocation(listing);
  const region = sourceRegion(listing);
  const country = sourceCountry(listing);
  const signal = [location, region].filter(Boolean).join(' ');
  const canton = inferAnyCanton(signal);
  const countryIsSwiss = !country || SWISS_COUNTRY_VALUES.has(country.toLowerCase());
  return {
    location,
    canton,
    valid: Boolean(location && canton && countryIsSwiss && isTargetSwissLocation(signal)),
  };
}

const parser = createProspectiveChParser({
  companyKey: RAIFFEISEN_KEY,
  companyName: RAIFFEISEN_COMPANY_NAME,
  companyDomain: RAIFFEISEN_COMPANY_DOMAIN,
  mediumId: '1950',
  apiLang: 'de',
  publicCareerUrl: 'https://jobs.raiffeisen.ch/',
  defaultSourceLang: 'de',
  strictPagination: true,
  locationResolver: resolveRaiffeisenLocation,
  postalCodeFallback: (canton) => getCantonPostalFallback(canton),
  extraTrustedHosts: ['jobs.raiffeisen.ch', 'www.raiffeisen.ch'],
  // Partition: drop the regional bank already covered by the dedicated
  // raiffeisen-vc crawler (see header comment above).
  filterListing: (listing) => !isVedeggioCassarateListing(listing),
});

export const fetchAllRaiffeisenJobs = parser.fetchAllJobs;
export const isRaiffeisenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;

// Exported for test coverage of the partition guarantee.
export { isVedeggioCassarateListing };
