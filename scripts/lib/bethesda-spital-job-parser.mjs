#!/usr/bin/env node
/**
 * Bethesda Spital Basel job parser — Umantis tenant 2998.
 *
 * Public career site: https://www.bethesda-spital.ch/de/ueber-uns/karriere/jobs.html
 * Raw listing:        https://recruitingapp-2998.umantis.com/Jobs/All?lang=ger
 *
 * Acquired Palliativzentrum Hildegard end of 2024; relocated to Bethesda
 * campus in 2025 — palliative care jobs surface under this same ATS.
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const BETHESDA_SPITAL_KEY = 'bethesda-spital';
export const BETHESDA_SPITAL_COMPANY_NAME = 'Bethesda Spital';
export const BETHESDA_SPITAL_COMPANY_DOMAIN = 'bethesda-spital.ch';

const parser = createUmantisListingParser({
  companyKey: BETHESDA_SPITAL_KEY,
  companyName: BETHESDA_SPITAL_COMPANY_NAME,
  companyDomain: BETHESDA_SPITAL_COMPANY_DOMAIN,
  tenantId: 2998,
  lang: 'ger',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4052',
  publicCareerUrl: 'https://www.bethesda-spital.ch/de/ueber-uns/karriere/jobs.html',
  defaultSourceLang: 'de',
});

export const fetchAllBethesdaSpitalJobs = parser.fetchAllJobs;
export const isBethesdaSpitalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
