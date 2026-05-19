#!/usr/bin/env node
/**
 * ipw — Integrierte Psychiatrie Winterthur job parser — Umantis tenant 2906.
 *
 * Public career site: https://www.ipw.ch/karriere
 * Raw listing:        https://recruitingapp-2906.umantis.com/Jobs/All?lang=ger
 *
 * Psychiatric services for the region Winterthur–Zürcher Unterland (ZH).
 *
 * Newer Umantis UI (column-value spans).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const IPW_KEY = 'ipw';
export const IPW_COMPANY_NAME = 'Integrierte Psychiatrie Winterthur (ipw)';
export const IPW_COMPANY_DOMAIN = 'ipw.ch';

const parser = createUmantisListingParser({
  companyKey: IPW_KEY,
  companyName: IPW_COMPANY_NAME,
  companyDomain: IPW_COMPANY_DOMAIN,
  tenantId: 2906,
  lang: 'ger',
  defaultCanton: 'ZH',
  defaultCity: 'Winterthur',
  defaultPostalCode: '8408',
  publicCareerUrl: 'https://www.ipw.ch/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllIpwJobs = parser.fetchAllJobs;
export const isIpwJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
