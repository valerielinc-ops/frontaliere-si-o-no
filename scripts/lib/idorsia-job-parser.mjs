#!/usr/bin/env node
/**
 * Idorsia Pharmaceuticals job parser — SAP SuccessFactors Career Site
 * Builder (CSB).
 *
 * Public career site: https://careers.idorsia.com
 * SF tenant code: Idorsia
 *
 * Idorsia Pharmaceuticals is a Swiss biopharmaceutical company headquartered
 * in Allschwil (BL) — a spin-off of Actelion. The corporate site
 * (idorsia.com/careers) links out via a "Continue to our Career Portal?"
 * redirect modal to the actual CSB tenant at careers.idorsia.com.
 *
 * careers.idorsia.com is a global career portal (US/EU/APAC listings); the
 * `locationsearch=Switzerland` server-side filter restricts the `/search/`
 * listing to CH jobs (7 open positions observed, incl. Allschwil BL).
 *
 * CSB listing (`/search/`) + detail (`/job/{slug}/{jobId}/`) parsing lives in
 * `scripts/lib/successfactors-shared-job-parser-common.mjs` — see
 * `scripts/lib/bachem-job-parser.mjs` for the identical pattern (another
 * Swiss biotech/pharma CSB tenant).
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const IDORSIA_KEY = 'idorsia';
export const IDORSIA_COMPANY_NAME = 'Idorsia Pharmaceuticals';
export const IDORSIA_COMPANY_DOMAIN = 'idorsia.com';

const parser = createSuccessFactorsParser({
  companyKey: IDORSIA_KEY,
  companyName: IDORSIA_COMPANY_NAME,
  companyDomain: IDORSIA_COMPANY_DOMAIN,
  sfCompanyId: 'Idorsia',
  publicCareerUrl: 'https://careers.idorsia.com',
  defaultCanton: 'BL',
  defaultCity: 'Allschwil',
  defaultPostalCode: '4123',
  defaultSourceLang: 'en',
  searchParams: { locationsearch: 'Switzerland' },
  sourceLabel: 'Idorsia Pharmaceuticals Dedicated Parser (SuccessFactors CSB)',
  sector: 'Biotech / Farmaceutico',
  fallbackCategory: 'Amministrazione',
});

export const fetchAllIdorsiaJobs = parser.fetchAllJobs;
export const isIdorsiaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
