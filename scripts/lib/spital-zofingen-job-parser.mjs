#!/usr/bin/env node
/**
 * Spital Zofingen AG job parser — Umantis tenant 22707.
 *
 * Public career site: https://jobs.spitalzofingen.ch/
 *   The custom-domain career portal is a static wrapper that links straight
 *   into recruitingapp-22707.umantis.com for each vacancy detail.
 * Raw listing:        https://recruitingapp-22707.umantis.com/Jobs/All?lang=ger
 *
 * Regional hospital in Zofingen, canton Aargau (part of KSA Aargau hospital
 * group but with its own dedicated Umantis tenant).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const SPITAL_ZOFINGEN_KEY = 'spital-zofingen';
export const SPITAL_ZOFINGEN_COMPANY_NAME = 'Spital Zofingen';
export const SPITAL_ZOFINGEN_COMPANY_DOMAIN = 'spitalzofingen.ch';

const parser = createUmantisListingParser({
  companyKey: SPITAL_ZOFINGEN_KEY,
  companyName: SPITAL_ZOFINGEN_COMPANY_NAME,
  companyDomain: SPITAL_ZOFINGEN_COMPANY_DOMAIN,
  tenantId: 22707,
  lang: 'ger',
  defaultCanton: 'AG',
  defaultCity: 'Zofingen',
  defaultPostalCode: '4800',
  publicCareerUrl: 'https://jobs.spitalzofingen.ch/',
  defaultSourceLang: 'de',
});

export const fetchAllSpitalZofingenJobs = parser.fetchAllJobs;
export const isSpitalZofingenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
