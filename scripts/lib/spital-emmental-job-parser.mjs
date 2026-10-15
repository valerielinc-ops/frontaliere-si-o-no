#!/usr/bin/env node
/**
 * Spital Emmental job parser — Solique career-portal (live.solique.ch).
 *
 * Spital Emmental AG operates the Burgdorf and Langnau campuses plus a network
 * of regional outpatient clinics across the Emmental region (BE). Public
 * career site:
 *   https://www.spital-emmental.ch/jobs (iframe-redirects to Solique)
 *   https://live.solique.ch/spital-emmental/ (server-rendered HTML, ~50 jobs)
 *
 * Solique is a Swiss careers-portal SaaS (Solique AG, Bern) used by several
 * mid-size hospitals — see `scripts/lib/solique-common.mjs` for the shared
 * factory that handles tile parsing, detail extraction, and ParsedJob
 * assembly.
 *
 * Spital Emmental ships listings with two-campus locations
 * ("Burgdorf & Langnau"). The factory picks the first campus token for the
 * structured city, but keeps the original string in `location`. The
 * `postalCodeForCity` mapper below covers the four campus ZIPs.
 */
import { createSoliqueParser } from './solique-common.mjs';

export const SPITAL_EMMENTAL_KEY = 'spital-emmental';
export const SPITAL_EMMENTAL_COMPANY_NAME = 'Spital Emmental';
export const SPITAL_EMMENTAL_COMPANY_DOMAIN = 'spital-emmental.ch';

function emmentalPostalCodeForCity(city = '') {
  const c = String(city || '').toLowerCase();
  if (c.includes('langnau')) return '3550';
  if (c.includes('huttwil')) return '4950';
  if (c.includes('niederbipp')) return '4704';
  return '3400'; // Burgdorf default
}

const parser = createSoliqueParser({
  soliqueTenant: 'spital-emmental',
  companyKey: SPITAL_EMMENTAL_KEY,
  companyName: SPITAL_EMMENTAL_COMPANY_NAME,
  companyDomain: SPITAL_EMMENTAL_COMPANY_DOMAIN,
  publicCareerUrl: 'https://www.spital-emmental.ch/jobs',
  defaultCanton: 'BE',
  defaultCity: 'Burgdorf',
  defaultPostalCode: '3400',
  defaultSourceLang: 'de',
  sourceLabel: `${SPITAL_EMMENTAL_COMPANY_NAME} Dedicated Parser (Solique careers portal)`,
  extraTrustedHosts: ['rse.abacuscity.ch'], // spontaneous-application target
  postalCodeForCity: emmentalPostalCodeForCity,
});

export const fetchAllSpitalEmmentalJobs = parser.fetchAllJobs;
export const isSpitalEmmentalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;

// Re-export listing/detail parsers for any external smoke-tests that
// imported the previous standalone helpers.
export { parseSoliqueListing as parseEmmentalListing, extractSoliqueDetailContent as extractEmmentalDetailContent } from './solique-common.mjs';
