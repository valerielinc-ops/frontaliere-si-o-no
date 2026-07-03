#!/usr/bin/env node
/**
 * Grand Resort Bad Ragaz AG job parser — Prospective.ch (medium 1004484).
 *
 * Public career site: https://www.resortragaz-gruppe.ch/de/karriere/stellenangebote
 *                      (the `jobs.resortragaz.ch` vanity host 301s here)
 * API:                 https://ohws.prospective.ch/public/v1/medium/1004484/jobs
 *
 * Grand Resort Bad Ragaz is a genuine luxury resort/spa/thermal-bath hotel
 * group in Bad Ragaz (SG) — direct employer, not a staffing agency. All 26
 * listings at discovery time were single-site (Bad Ragaz), so the shared
 * factory's HQ-fallback (`defaultCity`/`defaultPostalCode`/
 * `defaultStreetAddress`) covers postal/street for every job — the tenant's
 * `sza_workplace.city` field already resolves to "Bad Ragaz" on every
 * listing.
 *
 * NOTE — hospitality contract mix: ~35% of listings (9/26 at discovery) are
 * `befristet` (fixed-term), vs. the shared factory's `pickEmploymentType()`,
 * which only derives FULL_TIME/PART_TIME/OTHER from pensum% (same as every
 * other Prospective consumer — it doesn't map fixed-term/seasonal contracts
 * to schema.org TEMPORARY). This is an honest limitation, not fabricated
 * data: employmentType is still populated with a safe, non-fabricated value
 * per job.
 *
 * Uses the shared Prospective.ch factory. This tenant is hospitality, not
 * healthcare, so `sector`/`defaultCategory` are overridden (factory
 * defaults to 'Sanità / Ospedali' for its original hospital consumers —
 * see prospective-ch-job-parser-common.mjs).
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const GRAND_RESORT_BAD_RAGAZ_KEY = 'grand-resort-bad-ragaz';
export const GRAND_RESORT_BAD_RAGAZ_COMPANY_NAME = 'Grand Resort Bad Ragaz';
export const GRAND_RESORT_BAD_RAGAZ_COMPANY_DOMAIN = 'resortragaz.ch';

const parser = createProspectiveChParser({
  companyKey: GRAND_RESORT_BAD_RAGAZ_KEY,
  companyName: GRAND_RESORT_BAD_RAGAZ_COMPANY_NAME,
  companyDomain: GRAND_RESORT_BAD_RAGAZ_COMPANY_DOMAIN,
  mediumId: '1004484',
  apiLang: 'de',
  defaultCanton: 'SG',
  defaultCity: 'Bad Ragaz',
  defaultPostalCode: '7310',
  defaultStreetAddress: 'Bernhard-Simonstrasse 20',
  publicCareerUrl: 'https://www.resortragaz-gruppe.ch/de/karriere/stellenangebote',
  defaultSourceLang: 'de',
  // `jobs.resortragaz.ch` (Prospective directlink host) is already covered
  // by the `companyDomain` apex-suffix rule. The holding-group domain that
  // actually hosts the public listings page is a different apex, so it
  // needs an explicit trust entry.
  extraTrustedHosts: [
    'resortragaz-gruppe.ch',
    'www.resortragaz-gruppe.ch',
  ],
  sector: 'Turismo / Ospitalità',
  defaultCategory: 'Ospitalità',
});

export const fetchAllGrandResortBadRagazJobs = parser.fetchAllJobs;
export const isGrandResortBadRagazJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
