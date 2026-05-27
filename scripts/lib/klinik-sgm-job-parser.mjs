#!/usr/bin/env node
/**
 * Klinik SGM Langenthal job parser — Prospective.ch (medium tenant 1002870).
 *
 * Public career site: https://www.klinik-sgm.ch/karriere
 *   The site links each advert to https://jobs.klinik-sgm.ch/offene-stellen/...
 *   The JSON listing is available at
 *   https://ohws.prospective.ch/public/v1/medium/1002870/jobs?lang=de
 *
 * Klinik SGM is a Christian-values private psychiatric / psychotherapy
 * clinic based in Langenthal (BE) with ambulatory branches in Bern,
 * Spiez and Meggen. Sizeable employer for psychiatrists, psychologists,
 * nurses and therapists across BE and central CH.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const KLINIK_SGM_KEY = 'klinik-sgm';
export const KLINIK_SGM_COMPANY_NAME = 'Klinik SGM Langenthal';
export const KLINIK_SGM_COMPANY_DOMAIN = 'klinik-sgm.ch';

const parser = createProspectiveChParser({
  companyKey: KLINIK_SGM_KEY,
  companyName: KLINIK_SGM_COMPANY_NAME,
  companyDomain: KLINIK_SGM_COMPANY_DOMAIN,
  mediumId: '1002870',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Langenthal',
  defaultPostalCode: '4900',
  publicCareerUrl: 'https://www.klinik-sgm.ch/karriere',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.klinik-sgm.ch'],
});

export const fetchAllKlinikSgmJobs = parser.fetchAllJobs;
export const isKlinikSgmJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
