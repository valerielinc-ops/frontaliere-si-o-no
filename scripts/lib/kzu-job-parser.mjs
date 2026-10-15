#!/usr/bin/env node
/**
 * KZU Kompetenzzentrum Pflege und Gesundheit (Zürcher Unterland) — Umantis tenant 1251.
 *
 * Public career site: https://www.kzu.ch/jobs-und-karriere
 * Raw listing:        https://recruitingapp-1251.umantis.com/Jobs/All?lang=ger
 *
 * KZU is a Zurich-based competence centre for nursing and health care covering
 * acute & transitional care, long-term care, Spitex (home care) and palliative
 * care, headquartered in Embrach (ZH 8424).
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const KZU_KEY = 'kzu';
export const KZU_COMPANY_NAME = 'KZU Kompetenzzentrum Pflege und Gesundheit';
export const KZU_COMPANY_DOMAIN = 'kzu.ch';

const parser = createUmantisListingParser({
  companyKey: KZU_KEY,
  companyName: KZU_COMPANY_NAME,
  companyDomain: KZU_COMPANY_DOMAIN,
  tenantId: 1251,
  lang: 'ger',
  defaultCanton: 'ZH',
  defaultCity: 'Embrach',
  defaultPostalCode: '8424',
  publicCareerUrl: 'https://www.kzu.ch/jobs-und-karriere',
  defaultSourceLang: 'de',
});

export const fetchAllKzuJobs = parser.fetchAllJobs;
export const isKzuJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
