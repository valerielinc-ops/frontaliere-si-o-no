#!/usr/bin/env node
/**
 * Trafigura job parser — Workday (tenant `trafigura`, site TrafiguraCareerSite).
 *
 * Trafigura is a Swiss-headquartered (Geneva) commodity trading company.
 * Public careers: https://trafigura.wd3.myworkdayjobs.com/en-US/TrafiguraCareerSite
 * Workday CXS API: https://trafigura.wd3.myworkdayjobs.com/wday/cxs/trafigura/TrafiguraCareerSite/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * Canton GE, postal 1207 (1 Rue de Jargonnant, Genève — Trafigura Geneva office).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const TRAFIGURA_KEY = 'trafigura';
export const TRAFIGURA_COMPANY_NAME = 'Trafigura';
export const TRAFIGURA_COMPANY_DOMAIN = 'trafigura.com';

const parser = createWorkdaySwissParser({
  companyKey: TRAFIGURA_KEY,
  companyName: TRAFIGURA_COMPANY_NAME,
  companyDomain: TRAFIGURA_COMPANY_DOMAIN,
  tenantHost: 'trafigura.wd3.myworkdayjobs.com',
  sitePath: 'TrafiguraCareerSite',
  careerUrl: 'https://trafigura.wd3.myworkdayjobs.com/en-US/TrafiguraCareerSite',
  defaultCanton: 'GE',
  defaultCity: 'Genève',
  defaultPostalCode: '1207',
  sector: 'Trading di materie prime',
  defaultSourceLang: 'en',
});

export const fetchAllTrafiguraJobs = parser.fetchAllJobs;
export const isTrafiguraJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
