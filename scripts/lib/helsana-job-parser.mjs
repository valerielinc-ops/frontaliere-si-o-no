#!/usr/bin/env node
/**
 * Helsana job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Helsana is Switzerland's largest health & accident insurer. Public career
 * site: https://careers.helsana.ch/ (SF CSB tenant code `Helsana`).
 *
 * All postings are Switzerland-based (CH-only insurer); main locations are
 * Dübendorf-Stettbach (HQ), Zürich, Bern, Basel. Canton ZH, postal 8600
 * (Zürichstrasse 130, Dübendorf).
 *
 * Uses the shared SuccessFactors factory — see
 * scripts/lib/successfactors-shared-job-parser-common.mjs.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const HELSANA_KEY = 'helsana';
export const HELSANA_COMPANY_NAME = 'Helsana';
export const HELSANA_COMPANY_DOMAIN = 'helsana.ch';

const parser = createSuccessFactorsParser({
  companyKey: HELSANA_KEY,
  companyName: HELSANA_COMPANY_NAME,
  companyDomain: HELSANA_COMPANY_DOMAIN,
  sfCompanyId: 'Helsana',
  publicCareerUrl: 'https://careers.helsana.ch',
  defaultCanton: 'ZH',
  defaultCity: 'Dübendorf',
  defaultPostalCode: '8600',
  defaultSourceLang: 'de',
  sourceLabel: 'Helsana Dedicated Parser (SuccessFactors CSB)',
  sector: 'Assicurazioni',
  fallbackCategory: 'Amministrazione',
});

export const fetchAllHelsanaJobs = parser.fetchAllJobs;
export const isHelsanaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
