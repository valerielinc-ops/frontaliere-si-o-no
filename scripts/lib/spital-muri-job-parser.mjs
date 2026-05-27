#!/usr/bin/env node
/**
 * Spital Muri AG job parser — Umantis tenant 2997.
 *
 * Public career site: https://www.spital-muri.ch/jobs/stellenangebote.html/725
 *   The public site embeds the listing via a `live.solique.ch/spital-muri/`
 *   iframe wrapper, which in turn proxies to recruitingapp-2997.umantis.com.
 * Raw listing:        https://recruitingapp-2997.umantis.com/Jobs/All?lang=ger
 *
 * Regional acute hospital in Muri, canton Aargau.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const SPITAL_MURI_KEY = 'spital-muri';
export const SPITAL_MURI_COMPANY_NAME = 'Spital Muri';
export const SPITAL_MURI_COMPANY_DOMAIN = 'spital-muri.ch';

const parser = createUmantisListingParser({
  companyKey: SPITAL_MURI_KEY,
  companyName: SPITAL_MURI_COMPANY_NAME,
  companyDomain: SPITAL_MURI_COMPANY_DOMAIN,
  tenantId: 2997,
  lang: 'ger',
  defaultCanton: 'AG',
  defaultCity: 'Muri',
  defaultPostalCode: '5630',
  publicCareerUrl: 'https://www.spital-muri.ch/jobs/stellenangebote.html/725',
  defaultSourceLang: 'de',
});

export const fetchAllSpitalMuriJobs = parser.fetchAllJobs;
export const isSpitalMuriJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
