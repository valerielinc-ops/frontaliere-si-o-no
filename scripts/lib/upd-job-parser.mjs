#!/usr/bin/env node
/**
 * Universitäre Psychiatrische Dienste Bern (UPD) job parser — Umantis tenant 2908.
 *
 * Public career site: https://www.upd.jobs/offene-stellen
 *   (www.upd.ch/karriere redirects to www.upd.jobs)
 *   The public site embeds the Umantis listing at
 *   https://recruitingapp-2908.umantis.com/Jobs/All?lang=ger
 *
 * UPD is the cantonal psychiatric services group for Bern — multiple sites in
 * the city of Bern and across the canton (Münsingen, Waldau, Ittigen, etc.).
 * ~3000 employees, largest psychiatric provider in canton BE.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const UPD_KEY = 'upd';
export const UPD_COMPANY_NAME = 'Universitäre Psychiatrische Dienste Bern (UPD)';
export const UPD_COMPANY_DOMAIN = 'upd.ch';

const parser = createUmantisListingParser({
  companyKey: UPD_KEY,
  companyName: UPD_COMPANY_NAME,
  companyDomain: UPD_COMPANY_DOMAIN,
  tenantId: 2908,
  lang: 'ger',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3000',
  publicCareerUrl: 'https://www.upd.jobs/offene-stellen',
  defaultSourceLang: 'de',
});

export const fetchAllUpdJobs = parser.fetchAllJobs;
export const isUpdJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
