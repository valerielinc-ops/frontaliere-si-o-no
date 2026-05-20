#!/usr/bin/env node
/**
 * Bürgenstock Hotels AG (Obbürgen, NW) — Umantis tenant 2850.
 *
 * Career site:    https://www.buergenstock.ch/de/karriere
 * Raw listing:    https://recruitingapp-2850.umantis.com/Jobs/All?lang=ger
 *
 * Includes ALL Bürgenstock properties (per user instruction "crawla anche
 * Bürgenstock Waldhotel nel caso di hotel"): Bürgenstock Hotel & Alpine
 * Spa, Waldhotel Health & Medical Excellence Rehabilitationsklinik,
 * Palace Hotel, Taverne 1879, Hotel Schweizerhof Bern (BE sister
 * property), etc. Job categories span hospitality, F&B, spa, medical
 * (Waldhotel), maintenance, and administration.
 *
 * NO medical-only post-filter: the user explicitly asked for the full
 * hospitality slate so the listings remain representative of cross-border
 * worker opportunities (mostly NW, some BE).
 *
 * `inferSwissTargetCanton` in the shared Umantis parser already routes
 * Bern-located postings to BE; default canton NW (Obbürgen) covers the
 * rest.
 */
import { createUmantisListingParser } from './umantis-listing-common.mjs';

export const BUERGENSTOCK_HOTELS_KEY = 'buergenstock-hotels';
export const BUERGENSTOCK_HOTELS_COMPANY_NAME = 'Bürgenstock Hotels AG';
export const BUERGENSTOCK_HOTELS_COMPANY_DOMAIN = 'buergenstock.ch';

const parser = createUmantisListingParser({
  companyKey: BUERGENSTOCK_HOTELS_KEY,
  companyName: BUERGENSTOCK_HOTELS_COMPANY_NAME,
  companyDomain: BUERGENSTOCK_HOTELS_COMPANY_DOMAIN,
  tenantId: 2850,
  lang: 'ger',
  defaultCanton: 'NW',
  defaultCity: 'Obbürgen',
  defaultPostalCode: '6363',
  publicCareerUrl: 'https://www.buergenstock.ch/de/karriere',
  defaultSourceLang: 'de',
});

export const fetchAllBuergenstockHotelsJobs = parser.fetchAllJobs;
export const isBuergenstockHotelsJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
