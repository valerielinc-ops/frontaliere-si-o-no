#!/usr/bin/env node
/**
 * Kantonsspital Uri (UR) job parser — rexx-systems ATS on `stellen.ksuri.ch`.
 *
 * Public career site: https://www.ksuri.ch/karriere
 *   → portal: https://stellen.ksuri.ch/stellenangebote.html
 *
 * ~23 open positions at the only acute hospital in the canton of Uri
 * (~650 employees, Altdorf 6460). Strong intake from the Reuss/Gotthard
 * corridor and an Italian-speaking Ticinese commuter audience just south
 * of the Gotthard tunnel.
 *
 * Uses the shared rexx-systems factory. Note the ATS subdomain is
 * `stellen.*` (not `jobs.*`) on this tenant.
 */
import { createRexxSystemsParser } from './rexx-systems-job-parser-common.mjs';

export const KANTONSSPITAL_URI_KEY = 'kantonsspital-uri';
export const KANTONSSPITAL_URI_COMPANY_NAME = 'Kantonsspital Uri';
export const KANTONSSPITAL_URI_COMPANY_DOMAIN = 'ksuri.ch';

const parser = createRexxSystemsParser({
  companyKey: KANTONSSPITAL_URI_KEY,
  companyName: KANTONSSPITAL_URI_COMPANY_NAME,
  companyDomain: KANTONSSPITAL_URI_COMPANY_DOMAIN,
  atsHost: 'stellen.ksuri.ch',
  defaultCanton: 'UR',
  defaultCity: 'Altdorf',
  defaultPostalCode: '6460',
  publicCareerUrl: 'https://www.ksuri.ch/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllKantonsspitalUriJobs = parser.fetchAllJobs;
export const isKantonsspitalUriJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
