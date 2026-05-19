#!/usr/bin/env node
/**
 * Medartis job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://careers.medartis.com/
 * SF tenant code:      medartis (vanity-portal only; no career5.* mirror)
 *
 * Medartis AG is a Swiss medtech company headquartered in Basel (BS),
 * developing and manufacturing titanium implants and surgical
 * instruments for trauma surgery, hand-surgery and CMF surgery.
 * ~16 open positions in CH at any given time.
 *
 * The career portal is a public CSB instance with a `/search` listing
 * endpoint — see `scripts/lib/successfactors-shared-job-parser-common.mjs`
 * for the platform details.
 *
 * Notes:
 *   - `searchParams: { locationsearch: 'Switzerland' }` restricts the
 *     server-side query to CH jobs (Medartis is global with US / DE /
 *     FR / AU / BR sites plus the Basel HQ).
 *   - Medartis detail pages expose only `description` / `adcode` /
 *     `customfield2` / `shifttype` propertyids — no `title` or
 *     `location` blocks. The factory falls back to:
 *       * `listing.title` (the `<a class="jobTitle-link">` text)
 *       * defaultCity / defaultCanton (the BS HQ) for missing location
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const MEDARTIS_KEY = 'medartis';
export const MEDARTIS_COMPANY_NAME = 'Medartis';
export const MEDARTIS_COMPANY_DOMAIN = 'medartis.com';

const parser = createSuccessFactorsParser({
  companyKey: MEDARTIS_KEY,
  companyName: MEDARTIS_COMPANY_NAME,
  companyDomain: MEDARTIS_COMPANY_DOMAIN,
  sfCompanyId: 'medartis',
  publicCareerUrl: 'https://careers.medartis.com',
  defaultCanton: 'BS',
  defaultCity: 'Basel',
  defaultPostalCode: '4057',
  defaultSourceLang: 'en',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'Medartis Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllMedartisJobs = parser.fetchAllJobs;
export const isMedartisJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
