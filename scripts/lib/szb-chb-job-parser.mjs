#!/usr/bin/env node
/**
 * Spitalzentrum Biel / Centre hospitalier Bienne (SZB-CHB) job parser —
 * Umantis ATS behind the vanity host `jobs.szb-chb.ch`.
 *
 * Public career site:
 *   https://www.spitalzentrum-biel.ch/jobs-karriere/offene-stellen
 *     → links to the bilingual Umantis listing at jobs.szb-chb.ch
 *
 * Listing endpoint: https://jobs.szb-chb.ch/Jobs/All?lang=ger
 *   Same Umantis 2023 server-rendered HTML layout used by Inselspital +
 *   Spital Männedorf + See-Spital. Tenant ID is masked behind the vanity
 *   CNAME, so we feed the factory a `customBaseUrl` instead of a numeric
 *   tenant.
 *
 * SZB-CHB is a bilingual (DE/FR) acute hospital in Biel/Bienne, BE.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const SZB_CHB_KEY = 'szb-chb';
export const SZB_CHB_COMPANY_NAME = 'Spitalzentrum Biel / Centre hospitalier Bienne';
export const SZB_CHB_COMPANY_DOMAIN = 'szb-chb.ch';

const parser = createUmantisListingParser({
  companyKey: SZB_CHB_KEY,
  companyName: SZB_CHB_COMPANY_NAME,
  companyDomain: SZB_CHB_COMPANY_DOMAIN,
  customBaseUrl: 'https://jobs.szb-chb.ch',
  lang: 'ger',
  defaultCanton: 'BE',
  defaultCity: 'Biel/Bienne',
  defaultPostalCode: '2502',
  publicCareerUrl: 'https://www.spitalzentrum-biel.ch/jobs-karriere/offene-stellen',
  defaultSourceLang: 'de',
});

export const fetchAllSzbChbJobs = parser.fetchAllJobs;
export const isSzbChbJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
