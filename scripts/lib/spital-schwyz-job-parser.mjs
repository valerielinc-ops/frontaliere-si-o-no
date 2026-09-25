#!/usr/bin/env node
/**
 * Spital Schwyz (SZ) job parser — rexx-systems ATS on `jobs.spital-schwyz.ch`.
 *
 * Public career site: https://www.spital-schwyz.ch/karriere/stellenangebote
 *   → portal: https://jobs.spital-schwyz.ch/stellenangebote.html
 *
 * ~23 open positions across acute care (Innere Medizin, Chirurgie, Anästhesie,
 * Geburtshilfe, Pflege, Therapien, Hauswirtschaft). Regional acute hospital
 * for the canton of Schwyz, located in the town of Schwyz (6430).
 *
 * Uses the shared rexx-systems factory.
 */
import { createRexxSystemsParser } from './rexx-systems-job-parser-common.mjs';

export const SPITAL_SCHWYZ_KEY = 'spital-schwyz';
export const SPITAL_SCHWYZ_COMPANY_NAME = 'Spital Schwyz';
export const SPITAL_SCHWYZ_COMPANY_DOMAIN = 'spital-schwyz.ch';

const parser = createRexxSystemsParser({
  companyKey: SPITAL_SCHWYZ_KEY,
  companyName: SPITAL_SCHWYZ_COMPANY_NAME,
  companyDomain: SPITAL_SCHWYZ_COMPANY_DOMAIN,
  atsHost: 'jobs.spital-schwyz.ch',
  defaultCanton: 'SZ',
  defaultCity: 'Schwyz',
  defaultPostalCode: '6430',
  publicCareerUrl: 'https://www.spital-schwyz.ch/karriere/stellenangebote',
  defaultSourceLang: 'de',
});

export const fetchAllSpitalSchwyzJobs = parser.fetchAllJobs;
export const isSpitalSchwyzJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
