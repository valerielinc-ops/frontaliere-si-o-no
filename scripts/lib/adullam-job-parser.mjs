#!/usr/bin/env node
/**
 * Adullam-Stiftung Basel & Riehen job parser — Umantis tenant 2562.
 *
 * Public career site: https://www.adullam.ch/stellen-karriere/offene-stellen
 * Raw listing:        https://recruitingapp-2562.umantis.com/Jobs/All?lang=ger
 *
 * Geriatric / palliative care foundation operating sites in:
 *   - Basel (Adullam Spital)
 *   - Riehen
 *
 * Older Umantis UI (pipe-separated text).
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const ADULLAM_KEY = 'adullam';
export const ADULLAM_COMPANY_NAME = 'Adullam-Stiftung';
export const ADULLAM_COMPANY_DOMAIN = 'adullam.ch';

const parser = createUmantisListingParser({
  companyKey: ADULLAM_KEY,
  companyName: ADULLAM_COMPANY_NAME,
  companyDomain: ADULLAM_COMPANY_DOMAIN,
  tenantId: 2562,
  lang: 'ger',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4054',
  publicCareerUrl: 'https://www.adullam.ch/stellen-karriere/offene-stellen',
  defaultSourceLang: 'de',
});

export const fetchAllAdullamJobs = parser.fetchAllJobs;
export const isAdullamJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
