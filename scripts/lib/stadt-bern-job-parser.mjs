#!/usr/bin/env node
/**
 * Stadt Bern (City of Bern municipal administration) job parser —
 * Prospective.ch ATS (medium 1840).
 *
 * Discovery tagged this employer "jobs.ch (feed)" / ATS "Custom (jobs.ch
 * affiliate)" — that tag was WRONG. Verified live: bern.ch/jobs redirects to
 * bern.ch/themen/arbeiten-fuer-die-stadt-bern/offene-stellen, which embeds an
 * iframe pointing at jobs.bern.ch (careercenter/1840), backed by the public
 * Prospective.ch v1 JSON API:
 *   https://ohws.prospective.ch/public/v1/medium/1840/jobs?lang=de
 *
 * Uses the shared Prospective.ch factory (createProspectiveChParser). Stadt
 * Bern jobs carry a per-listing address in the FLAT `sza_location` field
 * (e.g. "Murtenstrasse 100, 3001 Bern", "Junkerngasse 47, 3011 Bern") rather
 * than the dotted `sza_location.city`/`sza_workplace` keys most existing
 * tenants use — an additive fallback for this flat schema was added to
 * pickLocation/pickPostalCode/pickStreetAddress in
 * prospective-ch-job-parser-common.mjs so real per-job addresses resolve
 * instead of collapsing to one HQ default (a city administration spans many
 * buildings, confirmed against live data across multiple listings).
 *
 * Sector override: the shared factory hardcodes `sector: 'Sanità / Ospedali'`
 * unconditionally for every tenant (a pre-existing bug affecting all
 * non-hospital callers, e.g. unibe-job-parser.mjs). Rather than touching that
 * shared default, this parser locally re-tags every job as
 * 'Amministrazione Pubblica' (municipal administration), matching the
 * convention used by other public-sector dedicated crawlers
 * (kanton-gr-job-parser.mjs, gemeinde-st-moritz-job-parser.mjs).
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const STADT_BERN_KEY = 'stadt-bern';
export const STADT_BERN_COMPANY_NAME = 'Stadt Bern';
export const STADT_BERN_COMPANY_DOMAIN = 'bern.ch';

const PUBLIC_SECTOR_LABEL = 'Amministrazione Pubblica';

const parser = createProspectiveChParser({
  companyKey: STADT_BERN_KEY,
  companyName: STADT_BERN_COMPANY_NAME,
  companyDomain: STADT_BERN_COMPANY_DOMAIN,
  mediumId: '1840',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3011',
  defaultStreetAddress: 'Junkerngasse 47',
  publicCareerUrl: 'https://jobs.bern.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.bern.ch'],
});

/**
 * Fetch all Stadt Bern jobs, correcting the shared factory's hardcoded
 * 'Sanità / Ospedali' sector default to the public-administration label
 * used by other municipal/cantonal dedicated crawlers.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchAllStadtBernJobs() {
  const jobs = await parser.fetchAllJobs();
  return jobs.map((job) => ({ ...job, sector: PUBLIC_SECTOR_LABEL }));
}

export const isStadtBernJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
