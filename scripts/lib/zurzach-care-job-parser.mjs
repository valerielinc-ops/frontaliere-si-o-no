#!/usr/bin/env node
/**
 * ZURZACH Care job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://karriere.zurzachcare.ch/
 * SF tenant code:      ZURZACHCare
 *
 * ZURZACH Care is a Swiss rehabilitation hospital group headquartered in Bad
 * Zurzach (AG), operating ~10 sites across AG, ZH, GL, LU and BS. Largest
 * employer for medical rehabilitation in Switzerland. Their career portal is
 * a public CSB instance — see
 * `scripts/lib/successfactors-shared-job-parser-common.mjs` for the platform
 * details.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const ZURZACH_CARE_KEY = 'zurzach-care';
export const ZURZACH_CARE_COMPANY_NAME = 'ZURZACH Care';
export const ZURZACH_CARE_COMPANY_DOMAIN = 'zurzachcare.ch';

const parser = createSuccessFactorsParser({
  companyKey: ZURZACH_CARE_KEY,
  companyName: ZURZACH_CARE_COMPANY_NAME,
  companyDomain: ZURZACH_CARE_COMPANY_DOMAIN,
  sfCompanyId: 'ZURZACHCare',
  publicCareerUrl: 'https://karriere.zurzachcare.ch',
  defaultCanton: 'AG',
  defaultCity: 'Bad Zurzach',
  defaultPostalCode: '5330',
  defaultSourceLang: 'de',
  sourceLabel: 'ZURZACH Care Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllZurzachCareJobs = parser.fetchAllJobs;
export const isZurzachCareJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
