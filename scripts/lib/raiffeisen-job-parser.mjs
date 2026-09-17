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
 * Canton is inferred per-posting from the listing's own Swiss location via
 * the shared all-canton helpers, covering all 26 cantons. The sentinel
 * defaults below are required by the generic factory but are unreachable for
 * accepted records: the source geography gate rejects rows without a
 * resolvable Swiss location.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';

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

const SWISS_COUNTRY_RE = /^(?:ch|che|schweiz|suisse|svizzera|svizra|switzerland)$/i;

function sourceLocationValues(listing = {}) {
  const szas = listing?.szas || {};
  const values = [];
  for (const [key, value] of Object.entries(szas)) {
    if (!/^sza_(?:location|workplace)(?:\.\d+)?(?:\.(?:city|region))?$/.test(key)) continue;
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  const arbeitsort = listing?.attributes?.arbeitsort;
  if (Array.isArray(arbeitsort)) values.push(...arbeitsort);
  else if (arbeitsort) values.push(arbeitsort);
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function sourceCountryValues(listing = {}) {
  const szas = listing?.szas || {};
  return Object.entries(szas)
    .filter(([key]) => /^sza_(?:location|workplace)(?:\.\d+)?\.country$/.test(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

/**
 * Keep only listings whose own Prospective location is Swiss and resolvable.
 * The national medium can contain records without a usable location; those
 * must not inherit the old St. Gallen HQ canton in the shared factory.
 */
export function isSwissRaiffeisenListing(listing = {}) {
  const countries = sourceCountryValues(listing);
  if (countries.some((country) => !SWISS_COUNTRY_RE.test(country))) return false;
  return sourceLocationValues(listing).some((value) => (
    isTargetSwissLocation(value, { includeBorderProximity: false })
    && inferAnyCanton(value)
  ));
}

const parser = createProspectiveChParser({
  companyKey: RAIFFEISEN_KEY,
  companyName: RAIFFEISEN_COMPANY_NAME,
  companyDomain: RAIFFEISEN_COMPANY_DOMAIN,
  mediumId: '1950',
  apiLang: 'de',
  // Accepted records have a source-backed canton; these sentinels are only
  // required by the generic factory configuration and are unreachable after
  // `isSwissRaiffeisenListing` has filtered the raw feed.
  defaultCanton: 'CH',
  defaultCity: 'Svizzera',
  defaultPostalCode: '',
  publicCareerUrl: 'https://jobs.raiffeisen.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.raiffeisen.ch', 'www.raiffeisen.ch'],
  // Partition: drop the regional bank already covered by the dedicated
  // raiffeisen-vc crawler (see header comment above).
  filterListing: (listing) => (
    !isVedeggioCassarateListing(listing) && isSwissRaiffeisenListing(listing)
  ),
});

export async function fetchAllRaiffeisenJobs() {
  const jobs = await parser.fetchAllJobs();
  return jobs
    .map((job) => {
      const canton = inferAnyCanton(job?.location || job?.addressLocality || '');
      return canton ? { ...job, canton, addressRegion: canton } : null;
    })
    .filter(Boolean);
}
export const isRaiffeisenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;

// Exported for test coverage of the partition guarantee.
export { isVedeggioCassarateListing };
