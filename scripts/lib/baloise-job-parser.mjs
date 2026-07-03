#!/usr/bin/env node
/**
 * Baloise job parser — Prospective.ch (shared medium 1005736).
 *
 * Baloise (Baloise Holding AG / "Helvetia Baloise Holding AG" at the group
 * legal-entity level post-2026 merger) is a Swiss insurance and banking
 * group headquartered in Basel (Aeschengraben 21, CH-4001 Basel — see
 * https://www.baloise.com/en/home/information/site-notice.html).
 *
 * ATS discovery: the public-facing `careers.baloise.com` site (Avature ATS)
 * only lists Belgium/Luxembourg/Germany postings — zero Switzerland-based
 * jobs found there. The real source of live Swiss "Baloise"-branded postings
 * is the SAME Prospective.ch tenant already crawled by
 * `helvetia-job-parser.mjs` (medium 1005736, https://jobs.helvetia.com/):
 * post-merger, "Baloise Bank" retail-banking roles (workplace Solothurn /
 * Oensingen) are published there with `szas.sza_workplace` starting with
 * "Baloise " (e.g. "Baloise Solothurn, Amthausplatz 4, 4500 Solothurn"),
 * while everything else in the same feed is genuinely Helvetia-branded.
 *
 * This parser reuses the shared factory against the same medium, with the
 * INVERSE filter of `helvetia-job-parser.mjs` — so a listing surfaces under
 * exactly one of the two companyKeys, never both.
 *
 * Canton BS (Basel-Stadt), postal 4001, Aeschengraben 21 — used only as the
 * city-gated HQ fallback (postalCode/streetAddress apply only when the
 * resolved city text matches Basel) for a listing without a resolvable
 * address; the live Baloise-workplace listings found so far all resolve
 * their own SO-canton address from `sza_workplace`/`sza_location.zip` and
 * never hit this fallback.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const BALOISE_KEY = 'baloise';
export const BALOISE_COMPANY_NAME = 'Baloise';
export const BALOISE_COMPANY_DOMAIN = 'baloise.com';

const parser = createProspectiveChParser({
  companyKey: BALOISE_KEY,
  companyName: BALOISE_COMPANY_NAME,
  companyDomain: BALOISE_COMPANY_DOMAIN,
  mediumId: '1005736',
  apiLang: 'de',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4001',
  defaultStreetAddress: 'Aeschengraben 21',
  publicCareerUrl: 'https://www.baloise.com/en/home/jobs-career.html',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.helvetia.com', 'baloise.ch'],
  sharedMedium: true,
  filterListing: (listing) => /^\s*baloise/i.test(String(listing?.szas?.sza_workplace || '')),
});

export const fetchAllBaloiseJobs = parser.fetchAllJobs;
export const isBaloiseJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
