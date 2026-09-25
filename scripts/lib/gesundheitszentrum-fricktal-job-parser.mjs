#!/usr/bin/env node
/**
 * Gesundheitszentrum Fricktal AG (GZF) job parser — Umantis tenant 2924.
 *
 * Public career site: https://www.gzf.ch/karriere
 * Raw listing:        https://recruitingapp-2924.umantis.com/Jobs/All?lang=ger
 *
 * Regional health network for the Fricktal (AG) — acute hospital in Rheinfelden,
 * rehab/long-term care in Laufenburg.
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const GZF_KEY = 'gesundheitszentrum-fricktal';
export const GZF_COMPANY_NAME = 'Gesundheitszentrum Fricktal';
export const GZF_COMPANY_DOMAIN = 'gzf.ch';

const parser = createUmantisListingParser({
  companyKey: GZF_KEY,
  companyName: GZF_COMPANY_NAME,
  companyDomain: GZF_COMPANY_DOMAIN,
  tenantId: 2924,
  lang: 'ger',
  defaultCanton: 'AG',
  defaultCity: 'Rheinfelden',
  defaultPostalCode: '4310',
  publicCareerUrl: 'https://www.gzf.ch/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllGesundheitszentrumFricktalJobs = parser.fetchAllJobs;
export const isGesundheitszentrumFricktalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
