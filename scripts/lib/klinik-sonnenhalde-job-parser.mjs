#!/usr/bin/env node
/**
 * Klinik Sonnenhalde Riehen job parser — Umantis tenant 3030.
 *
 * Public career site: https://www.sonnenhalde.ch/de/stellenangebot.html
 * Raw listing:        https://recruitingapp-3030.umantis.com/Jobs/All?lang=ger
 *
 * Psychiatry & psychotherapy clinic in Riehen BS.
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const KLINIK_SONNENHALDE_KEY = 'klinik-sonnenhalde';
export const KLINIK_SONNENHALDE_COMPANY_NAME = 'Klinik Sonnenhalde';
export const KLINIK_SONNENHALDE_COMPANY_DOMAIN = 'sonnenhalde.ch';

const parser = createUmantisListingParser({
  companyKey: KLINIK_SONNENHALDE_KEY,
  companyName: KLINIK_SONNENHALDE_COMPANY_NAME,
  companyDomain: KLINIK_SONNENHALDE_COMPANY_DOMAIN,
  tenantId: 3030,
  lang: 'ger',
  defaultCanton: 'BS',
  defaultCity: 'Riehen',
  defaultPostalCode: '4125',
  publicCareerUrl: 'https://www.sonnenhalde.ch/de/stellenangebot.html',
  defaultSourceLang: 'de',
});

export const fetchAllKlinikSonnenhaldeJobs = parser.fetchAllJobs;
export const isKlinikSonnenhaldeJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
