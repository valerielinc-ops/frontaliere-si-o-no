#!/usr/bin/env node
/**
 * Schulthess Klinik (Zürich) job parser — Prospective.ch (medium 1007262).
 *
 * Schulthess Klinik is the leading orthopaedic clinic in Switzerland
 * (Lengghalde 2, 8008 Zürich), specialised in orthopaedic surgery, sports
 * medicine, rheumatology and rehabilitation. Like Balgrist and many other
 * Zürich-area hospitals it runs its career portal on the Swiss-built
 * Prospective.ch ATS.
 *
 * Public career page:
 *   https://www.schulthess-klinik.ch/de/jobs-und-karriere
 *     → embeds the Prospective careercenter SPA hosted at
 *       https://job.schulthess-klinik.ch/careercenter/1007262/
 *
 * The careercenter ID 1007262 maps directly to the Prospective v1 listing
 * endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1007262/jobs?lang=de
 *
 * Although Schulthess publishes a legacy form at
 * `https://job.schulthess-klinik.ch/successfactors/EMEA_ROT/SchulthessK/de/apply`
 * (looks like SuccessFactors path) the actual job feed is Prospective —
 * the SF path is just the application form. We therefore use the shared
 * Prospective.ch factory rather than the SuccessFactors CSB factory.
 *
 * Canton ZH, postal 8008 (Lengghalde 2).
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SCHULTHESS_KLINIK_KEY = 'schulthess-klinik';
export const SCHULTHESS_KLINIK_COMPANY_NAME = 'Schulthess Klinik';
export const SCHULTHESS_KLINIK_COMPANY_DOMAIN = 'schulthess-klinik.ch';

const parser = createProspectiveChParser({
  companyKey: SCHULTHESS_KLINIK_KEY,
  companyName: SCHULTHESS_KLINIK_COMPANY_NAME,
  companyDomain: SCHULTHESS_KLINIK_COMPANY_DOMAIN,
  mediumId: '1007262',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8008',
  publicCareerUrl: 'https://www.schulthess-klinik.ch/de/jobs-und-karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['job.schulthess-klinik.ch'],
});

export const fetchAllSchulthessKlinikJobs = parser.fetchAllJobs;
export const isSchulthessKlinikJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
