#!/usr/bin/env node
/**
 * Bachem AG job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://careers.bachem.com/
 * SF tenant code:      Bachem
 *
 * Bachem is a Swiss biotech company headquartered in Bubendorf (BL),
 * specialising in the development and manufacture of peptides and
 * oligonucleotides for the pharmaceutical and biotechnology industries
 * (research / clinical / commercial scale). ~74 open positions in CH.
 *
 * The career portal is a public CSB instance with a `/search` listing
 * endpoint — see `scripts/lib/successfactors-shared-job-parser-common.mjs`
 * for the platform details.
 *
 * Notes:
 *   - `searchParams: { locationsearch: 'Switzerland' }` restricts the
 *     server-side query to CH jobs (Bachem's global portal lists US +
 *     EU + APAC sites).
 *   - Bachem detail pages only expose `title` + `description` propertyids
 *     (no `location` block). The factory falls back to listing-cell location
 *     parsing via the dedicated `colLocation` `<td>`.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const BACHEM_KEY = 'bachem';
export const BACHEM_COMPANY_NAME = 'Bachem AG';
export const BACHEM_COMPANY_DOMAIN = 'bachem.com';

const parser = createSuccessFactorsParser({
  companyKey: BACHEM_KEY,
  companyName: BACHEM_COMPANY_NAME,
  companyDomain: BACHEM_COMPANY_DOMAIN,
  sfCompanyId: 'Bachem',
  publicCareerUrl: 'https://careers.bachem.com',
  defaultCanton: 'BL',
  defaultCity: 'Bubendorf',
  defaultPostalCode: '4416',
  defaultSourceLang: 'en',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'Bachem AG Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllBachemJobs = parser.fetchAllJobs;
export const isBachemJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
