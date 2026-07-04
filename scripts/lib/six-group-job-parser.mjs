#!/usr/bin/env node
/**
 * SIX Group job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * SIX operates the Swiss financial-market infrastructure (SIX Swiss Exchange,
 * payments, financial information). Public career site:
 * https://jobs.six-group.com/ (SF CSB tenant code `SIXGroupAG`).
 *
 * Most postings are in Zürich (HQ) and Olten; the tenant also lists a few
 * international roles, filtered downstream by the canton-quorum gate. Canton ZH,
 * postal 8005 (Pfingstweidstrasse 110, Zürich).
 *
 * Uses the shared SuccessFactors factory — see
 * scripts/lib/successfactors-shared-job-parser-common.mjs.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const SIX_GROUP_KEY = 'six-group';
export const SIX_GROUP_COMPANY_NAME = 'SIX Group';
export const SIX_GROUP_COMPANY_DOMAIN = 'six-group.com';

const parser = createSuccessFactorsParser({
  companyKey: SIX_GROUP_KEY,
  companyName: SIX_GROUP_COMPANY_NAME,
  companyDomain: SIX_GROUP_COMPANY_DOMAIN,
  sfCompanyId: 'SIXGroupAG',
  publicCareerUrl: 'https://jobs.six-group.com',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8005',
  defaultSourceLang: 'en',
  sourceLabel: 'SIX Group Dedicated Parser (SuccessFactors CSB)',
  sector: 'Finanza',
  fallbackCategory: 'Amministrazione',
});

export const fetchAllSixGroupJobs = parser.fetchAllJobs;
export const isSixGroupJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
