#!/usr/bin/env node
/**
 * PDAG — Psychiatrische Dienste Aargau AG job parser — Umantis tenant 22705.
 *
 * Public career site: https://www.pdag.ch/de/karriere.html
 * Raw listing:        https://recruitingapp-22705.umantis.com/Jobs/All?lang=ger
 *
 * Cantonal psychiatric services for Aargau, headquartered in Königsfelden
 * (Windisch). Five-digit tenant ID range (22xxx) shared with Spital Zofingen.
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const PDAG_KEY = 'pdag';
export const PDAG_COMPANY_NAME = 'Psychiatrische Dienste Aargau (PDAG)';
export const PDAG_COMPANY_DOMAIN = 'pdag.ch';

const parser = createUmantisListingParser({
  companyKey: PDAG_KEY,
  companyName: PDAG_COMPANY_NAME,
  companyDomain: PDAG_COMPANY_DOMAIN,
  tenantId: 22705,
  lang: 'ger',
  defaultCanton: 'AG',
  defaultCity: 'Windisch',
  defaultPostalCode: '5210',
  publicCareerUrl: 'https://www.pdag.ch/de/karriere.html',
  defaultSourceLang: 'de',
});

export const fetchAllPdagJobs = parser.fetchAllJobs;
export const isPdagJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
