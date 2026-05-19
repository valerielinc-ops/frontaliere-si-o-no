#!/usr/bin/env node
/**
 * STGAG (Spital Thurgau) Umantis-listing job parser.
 *
 * STGAG publishes the Umantis recruiting app behind a corporate subdomain
 * (`rekrutierung.stgag.ch`) — same vendor and HTML/UI as KSA/Bethesda/etc.,
 * but the numeric Umantis tenant ID is hidden behind a CNAME, so the
 * conventional `recruitingapp-{tenantId}.umantis.com` base URL does not work.
 *
 * Listing:        https://rekrutierung.stgag.ch/Jobs/All?lang=ger
 * Public career:  https://www.stgag.ch/karriere/bildung-karriere/
 *
 * This parser is intentionally separate from `spital-thurgau-job-parser.mjs`
 * (which reads the embedded JSON from www.stgag.ch/jobs/ and returns ~156
 * jobs). The Umantis listing only paginates 10 jobs at a time (factory
 * limitation shared by all 8 sibling wrappers); we keep both parsers so
 * future consolidation can compare coverage.
 *
 * Uses the shared `createUmantisListingParser` factory with the new
 * `customBaseUrl` option (no numeric tenantId available).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const STGAG_KEY = 'stgag';
export const STGAG_COMPANY_NAME = 'Spital Thurgau (STGAG)';
export const STGAG_COMPANY_DOMAIN = 'stgag.ch';

const parser = createUmantisListingParser({
  companyKey: STGAG_KEY,
  companyName: STGAG_COMPANY_NAME,
  companyDomain: STGAG_COMPANY_DOMAIN,
  customBaseUrl: 'https://rekrutierung.stgag.ch',
  lang: 'ger',
  defaultCanton: 'TG',
  defaultCity: 'Münsterlingen',
  defaultPostalCode: '8596',
  publicCareerUrl: 'https://www.stgag.ch/karriere/bildung-karriere/',
  defaultSourceLang: 'de',
});

export const fetchAllStgagJobs = parser.fetchAllJobs;
export const isStgagJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
