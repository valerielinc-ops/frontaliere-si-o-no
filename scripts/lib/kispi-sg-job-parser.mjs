#!/usr/bin/env node
/**
 * Ostschweizer Kinderspital (Kispi SG) job parser — Umantis tenant 2979.
 *
 * Public career site: https://www.kispisg.ch/stellen
 * Raw listing:        https://recruitingapp-2979.umantis.com/Jobs/All?lang=ger
 *
 * The kispisg.ch career page renders its own SSR list of jobs (Pimcore CMS),
 * but every "Jetzt bewerben" button targets the Umantis tenant 2979 portal.
 * The Umantis listing is the authoritative source — same set of jobs, with
 * stable Vacancies/{ID}/Description/1 URLs.
 *
 * Different from `kispi-job-parser.mjs` (Universitäts-Kinderspital beider
 * Basel) and `kispi-zurich-job-parser.mjs` — those are separate children's
 * hospitals with their own ATS tenants.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const KISPI_SG_KEY = 'kispi-sg';
export const KISPI_SG_COMPANY_NAME = 'Ostschweizer Kinderspital';
export const KISPI_SG_COMPANY_DOMAIN = 'kispisg.ch';

const parser = createUmantisListingParser({
  companyKey: KISPI_SG_KEY,
  companyName: KISPI_SG_COMPANY_NAME,
  companyDomain: KISPI_SG_COMPANY_DOMAIN,
  tenantId: 2979,
  lang: 'ger',
  defaultCanton: 'SG',
  defaultCity: 'St. Gallen',
  defaultPostalCode: '9006',
  publicCareerUrl: 'https://www.kispisg.ch/stellen',
  defaultSourceLang: 'de',
});

export const fetchAllKispiSgJobs = parser.fetchAllJobs;
export const isKispiSgJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
