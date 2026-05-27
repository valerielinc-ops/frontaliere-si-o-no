#!/usr/bin/env node
/**
 * Schweizerische Epilepsie-Stiftung (EPI) job parser — Prospective.ch (medium 1008439).
 *
 * The EPI Stiftung is a non-profit Mehrspartenunternehmen at Bleulerstrasse 60,
 * 8008 Zürich (Lengg area). It comprises the EPI Spital (epilepsy and
 * neuro-rehab clinic), the EPI WohnWerk (residential and sheltered work
 * for adults with epilepsy / neuro-disabilities), the EPI Schule (special-needs
 * school), the EPI Park (seminar centre + public restaurant), and various
 * support services (Hotellerie, Küche, Reinigung).
 *
 * Sister entity Klinik Lengg AG (medium 1008440, parser already in repo)
 * shares the same campus but is a distinct legal entity / Prospective tenant.
 * Treat EPI and Klinik Lengg as two independent employers.
 *
 * Public career site (Prospective careercenter SPA):
 *   https://jobs.epi.ch/  → medium 1008439
 *
 * API:
 *   https://ohws.prospective.ch/public/v1/medium/1008439/jobs?lang=de&offset=0&limit=100
 *
 * All listings observed today are at the single Lengg campus
 * (Bleulerstrasse 60, 8008 Zürich), so canton ZH + postal 8008 + city Zürich
 * are safe defaults; the shared factory still reads per-job overrides
 * when Prospective populates them.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const EPI_STIFTUNG_KEY = 'epi-stiftung';
export const EPI_STIFTUNG_COMPANY_NAME = 'Schweizerische Epilepsie-Stiftung (EPI)';
export const EPI_STIFTUNG_COMPANY_DOMAIN = 'epi.ch';

const parser = createProspectiveChParser({
  companyKey: EPI_STIFTUNG_KEY,
  companyName: EPI_STIFTUNG_COMPANY_NAME,
  companyDomain: EPI_STIFTUNG_COMPANY_DOMAIN,
  mediumId: '1008439',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8008',
  publicCareerUrl: 'https://jobs.epi.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.epi.ch', 'job.swissepi.ch', 'swissepi.ch'],
});

export const fetchAllEpiStiftungJobs = parser.fetchAllJobs;
export const isEpiStiftungJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
