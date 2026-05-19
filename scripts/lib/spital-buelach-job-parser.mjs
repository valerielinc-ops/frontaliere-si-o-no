#!/usr/bin/env node
/**
 * Spital Bülach job parser.
 *
 * Public career site: https://www.spitalbuelach.ch/offene-stellen
 *   → embeds an iframe to ohws.prospective.ch (Prospective.ch ATS, v2 UI)
 *
 * The v2 iframe SPA still calls the well-known v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1006135/jobs
 *     ?lang=de&offset=0&limit=100
 *
 * Returns 39+ jobs (Pflege, Ärzte, MTRA, Hotellerie, Lehrstellen, ...) for the
 * 1'600-employee acute hospital in canton Zürich.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SPITAL_BUELACH_KEY = 'spital-buelach';
export const SPITAL_BUELACH_COMPANY_NAME = 'Spital Bülach';
export const SPITAL_BUELACH_COMPANY_DOMAIN = 'spitalbuelach.ch';

const parser = createProspectiveChParser({
  companyKey: SPITAL_BUELACH_KEY,
  companyName: SPITAL_BUELACH_COMPANY_NAME,
  companyDomain: SPITAL_BUELACH_COMPANY_DOMAIN,
  mediumId: '1006135',
  defaultCanton: 'ZH',
  defaultCity: 'Bülach',
  defaultPostalCode: '8180',
  apiLang: 'de',
  defaultSourceLang: 'de',
  publicCareerUrl: 'https://www.spitalbuelach.ch/offene-stellen',
});

export const fetchAllSpitalBuelachJobs = parser.fetchAllJobs;
export const isSpitalBuelachJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
