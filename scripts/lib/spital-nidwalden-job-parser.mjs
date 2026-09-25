#!/usr/bin/env node
/**
 * Spital Nidwalden job parser — Prospective.ch tenant 1003280 (shared with LUKS).
 *
 * Spital Nidwalden (formerly Kantonsspital Nidwalden, KSNW) is part of the
 * LUKS group since 2020 and publishes its openings into the same
 * Prospective.ch tenant as Luzerner Kantonsspital. The tenant tags each
 * listing with attribute `40 = 'KSNW' | 'LUKS'`; we keep only the KSNW
 * subset here, leaving the LUKS-tagged jobs to `luks-job-parser.mjs`.
 *
 * Public career site: https://www.spital-nidwalden.ch/offene-stellen
 *   → Drupal landing page; jobs are fetched client-side from the same
 *     Prospective tenant as LUKS (https://jobs.luks.ch).
 * API: https://ohws.prospective.ch/public/v1/medium/1003280/jobs?lang=de
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SPITAL_NIDWALDEN_KEY = 'spital-nidwalden';
export const SPITAL_NIDWALDEN_COMPANY_NAME = 'Spital Nidwalden';
export const SPITAL_NIDWALDEN_COMPANY_DOMAIN = 'spital-nidwalden.ch';

const parser = createProspectiveChParser({
  companyKey: SPITAL_NIDWALDEN_KEY,
  companyName: SPITAL_NIDWALDEN_COMPANY_NAME,
  companyDomain: SPITAL_NIDWALDEN_COMPANY_DOMAIN,
  mediumId: '1003280',
  apiLang: 'de',
  defaultCanton: 'NW',
  defaultCity: 'Stans',
  defaultPostalCode: '6370',
  publicCareerUrl: 'https://www.spital-nidwalden.ch/offene-stellen',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.luks.ch', 'recruitment.luks.ch'],
  filterListing: (listing) => {
    const tag = Array.isArray(listing?.attributes?.['40'])
      ? listing.attributes['40'].map((s) => String(s || '').toUpperCase())
      : [];
    return tag.includes('KSNW');
  },
});

export const fetchAllSpitalNidwaldenJobs = parser.fetchAllJobs;
export const isSpitalNidwaldenJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
