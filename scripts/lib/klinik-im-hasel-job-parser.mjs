#!/usr/bin/env node
/**
 * Klinik im Hasel AG job parser — Umantis tenant 2912.
 *
 * Public career site: https://www.klinikimhasel.ch/karriere
 * Raw listing:        https://recruitingapp-2912.umantis.com/Jobs/All?lang=ger
 *
 * Specialised clinic for addiction therapy & psychosomatic medicine in
 * Gontenschwil (AG).
 *
 * Older Umantis UI (pipe-separated metadata).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const KLINIK_IM_HASEL_KEY = 'klinik-im-hasel';
export const KLINIK_IM_HASEL_COMPANY_NAME = 'Klinik im Hasel';
export const KLINIK_IM_HASEL_COMPANY_DOMAIN = 'klinikimhasel.ch';

const parser = createUmantisListingParser({
  companyKey: KLINIK_IM_HASEL_KEY,
  companyName: KLINIK_IM_HASEL_COMPANY_NAME,
  companyDomain: KLINIK_IM_HASEL_COMPANY_DOMAIN,
  tenantId: 2912,
  lang: 'ger',
  defaultCanton: 'AG',
  defaultCity: 'Gontenschwil',
  defaultPostalCode: '5728',
  publicCareerUrl: 'https://www.klinikimhasel.ch/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllKlinikImHaselJobs = parser.fetchAllJobs;
export const isKlinikImHaselJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
