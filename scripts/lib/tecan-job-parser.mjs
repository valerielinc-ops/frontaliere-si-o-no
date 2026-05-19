#!/usr/bin/env node
/**
 * Tecan job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://careers.tecan.com/
 * SF tenant code:      tecan (vanity-portal only; no career5.* mirror)
 *
 * Tecan is a Swiss medtech company headquartered in Männedorf (ZH),
 * world-leader in laboratory automation and liquid-handling instruments
 * for life-science, diagnostics and clinical research. ~14 open
 * positions in CH at any given time.
 *
 * The career portal is a public CSB instance with a `/search` listing
 * endpoint — see `scripts/lib/successfactors-shared-job-parser-common.mjs`
 * for the platform details.
 *
 * Notes:
 *   - `searchParams: { locationsearch: 'Switzerland' }` restricts the
 *     server-side query to CH jobs (Tecan's global portal lists US +
 *     EU + APAC sites).
 *   - Tecan detail pages expose separate `city` + `country` propertyids
 *     (not the canonical `location` block). When `city` is empty the
 *     factory falls back to `defaultCity` (Männedorf) and skips the
 *     country-only fallback automatically.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const TECAN_KEY = 'tecan';
export const TECAN_COMPANY_NAME = 'Tecan';
export const TECAN_COMPANY_DOMAIN = 'tecan.com';

const parser = createSuccessFactorsParser({
  companyKey: TECAN_KEY,
  companyName: TECAN_COMPANY_NAME,
  companyDomain: TECAN_COMPANY_DOMAIN,
  sfCompanyId: 'tecan',
  publicCareerUrl: 'https://careers.tecan.com',
  defaultCanton: 'ZH',
  defaultCity: 'Männedorf',
  defaultPostalCode: '8708',
  defaultSourceLang: 'en',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'Tecan Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllTecanJobs = parser.fetchAllJobs;
export const isTecanJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
