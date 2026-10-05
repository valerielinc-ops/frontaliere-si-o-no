#!/usr/bin/env node
/**
 * Temenos job parser — Workday (tenant `temenos`, site Temenoscareers).
 *
 * Temenos is a Swiss banking-software company headquartered in Geneva. Public
 * careers: https://careers.temenos.com/
 * Workday CXS API: https://temenos.wd103.myworkdayjobs.com/wday/cxs/temenos/Temenoscareers/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard) —
 * the global board lists many non-CH roles which are filtered out.
 * Canton GE, postal 1196 (Route de Lausanne, Genève region — HQ Geneva).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const TEMENOS_KEY = 'temenos';
export const TEMENOS_COMPANY_NAME = 'Temenos';
export const TEMENOS_COMPANY_DOMAIN = 'temenos.com';

const parser = createWorkdaySwissParser({
  companyKey: TEMENOS_KEY,
  companyName: TEMENOS_COMPANY_NAME,
  companyDomain: TEMENOS_COMPANY_DOMAIN,
  tenantHost: 'temenos.wd103.myworkdayjobs.com',
  sitePath: 'Temenoscareers',
  careerUrl: 'https://careers.temenos.com/',
  defaultCanton: 'GE',
  defaultCity: 'Genève',
  defaultPostalCode: '1196',
  sector: 'Software / Fintech',
  defaultSourceLang: 'en',
  // `locationMainGroup` is a nested display group, not an applied country
  // facet. The standard key is rejected on this tenant, so the factory falls
  // back to the complete global board and proves a zero only when every
  // posting's own structured primary country is foreign.
  proveSwissAbsentFromLiveBoard: true,
  proveForeignOnlyBoardEmpty: true,
});

export const fetchAllTemenosJobs = parser.fetchAllJobs;
export const isTemenosJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
