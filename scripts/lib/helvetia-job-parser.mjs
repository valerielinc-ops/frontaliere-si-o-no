#!/usr/bin/env node
/**
 * Helvetia Versicherungen job parser — Prospective.ch (medium 1005736).
 *
 * Helvetia is a Swiss all-lines insurer headquartered in St. Gallen. Its public
 * career site (https://jobs.helvetia.com/) embeds a Prospective.ch careercenter;
 * the careercenter ID matches the Prospective v1 JSON listing endpoint:
 *   https://ohws.prospective.ch/public/v1/medium/1005736/jobs?lang=de
 *
 * All postings are Switzerland-based (CH-only insurer); subsidiary brands
 * (MoneyPark / Helvetia Consulting) surface under the same tenant.
 *
 * Canton SG, postal 9001 (Dufourstrasse 40, St. Gallen).
 *
 * Post-merger overlap (2026-07): medium 1005736 also carries "Baloise Bank"
 * postings (workplace = Solothurn/Oensingen, `sza_workplace` starting with
 * "Baloise ") — these are branded/operated as Baloise, not Helvetia, so they
 * are excluded here via `filterListing` and instead surface under the
 * dedicated `baloise-job-parser.mjs` (same tenant, inverse filter). Without
 * this split every "Baloise ..." listing would double-count under both
 * companyKeys.
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const HELVETIA_KEY = 'helvetia';
export const HELVETIA_COMPANY_NAME = 'Helvetia Versicherungen';
export const HELVETIA_COMPANY_DOMAIN = 'helvetia.com';

const parser = createProspectiveChParser({
  companyKey: HELVETIA_KEY,
  companyName: HELVETIA_COMPANY_NAME,
  companyDomain: HELVETIA_COMPANY_DOMAIN,
  mediumId: '1005736',
  apiLang: 'de',
  defaultCanton: 'SG',
  defaultCity: 'St. Gallen',
  defaultPostalCode: '9001',
  publicCareerUrl: 'https://jobs.helvetia.com/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['jobs.helvetia.com'],
  sharedMedium: true,
  filterListing: (listing) => !/^\s*baloise/i.test(String(listing?.szas?.sza_workplace || '')),
});

export const fetchAllHelvetiaJobs = parser.fetchAllJobs;
export const isHelvetiaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
