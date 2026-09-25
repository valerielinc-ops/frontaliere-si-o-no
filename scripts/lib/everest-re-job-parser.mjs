#!/usr/bin/env node
/**
 * Everest Re job parser — Workday (tenant `everestre`, site `External`).
 *
 * Everest Re is a Swiss/Bermudian reinsurance group with its EMEA hub in
 * Zurich. Public careers: https://everestre.wd5.myworkdayjobs.com/External
 * Workday CXS API: https://everestre.wd5.myworkdayjobs.com/wday/cxs/everestre/External/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * Canton ZH, postal 8001 (Zurich).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const EVEREST_RE_KEY = 'everest-re';
export const EVEREST_RE_COMPANY_NAME = 'Everest Re';
export const EVEREST_RE_COMPANY_DOMAIN = 'everestre.com';

const parser = createWorkdaySwissParser({
  companyKey: EVEREST_RE_KEY,
  companyName: EVEREST_RE_COMPANY_NAME,
  companyDomain: EVEREST_RE_COMPANY_DOMAIN,
  tenantHost: 'everestre.wd5.myworkdayjobs.com',
  sitePath: 'External',
  careerUrl: 'https://everestre.wd5.myworkdayjobs.com/External',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8001',
  sector: 'Assicurazioni / Riassicurazione',
  defaultSourceLang: 'en',
});

export const fetchAllEverestReJobs = parser.fetchAllJobs;
export const isEverestReJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
