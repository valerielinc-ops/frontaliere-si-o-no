#!/usr/bin/env node
/**
 * Schweizer Paraplegiker-Gruppe (SPG) job parser — Umantis tenant 2782.
 *
 * Public career site: https://www.paraplegie.ch/de/karriere/offene-stellen/
 * Raw listing:        https://recruitingapp-2782.umantis.com/Jobs/All?lang=ger
 *
 * Umbrella organisation in Nottwil LU covering:
 *   - Schweizer Paraplegiker-Zentrum (SPZ, rehabilitation clinic)
 *   - Schweizer Paraplegiker-Stiftung (SPS, foundation)
 *   - Schweizer Paraplegiker-Vereinigung (SPV)
 *   - Schweizer Paraplegiker-Forschung (SPF)
 *   - ParaHelp (homecare for paraplegic patients)
 *   - Active Communication AG (assistive tech)
 *   - Orthotec AG (orthopaedic technology)
 *   - Sirmed AG (Swiss Institute of Emergency Medicine, Nottwil)
 *   - Hotel Sempachersee
 *
 * All sub-entities publish their vacancies through this single Umantis tenant
 * — the company-value column on the listing rows surfaces the operating
 * unit (e.g. "Sirmed", "SPZ"). Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const PARAPLEGIE_KEY = 'paraplegie';
export const PARAPLEGIE_COMPANY_NAME = 'Schweizer Paraplegiker-Gruppe';
export const PARAPLEGIE_COMPANY_DOMAIN = 'paraplegie.ch';

const parser = createUmantisListingParser({
  companyKey: PARAPLEGIE_KEY,
  companyName: PARAPLEGIE_COMPANY_NAME,
  companyDomain: PARAPLEGIE_COMPANY_DOMAIN,
  tenantId: 2782,
  lang: 'ger',
  defaultCanton: 'LU',
  defaultCity: 'Nottwil',
  defaultPostalCode: '6207',
  publicCareerUrl: 'https://www.paraplegie.ch/de/karriere/offene-stellen/',
  defaultSourceLang: 'de',
});

export const fetchAllParaplegieJobs = parser.fetchAllJobs;
export const isParaplegieJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
