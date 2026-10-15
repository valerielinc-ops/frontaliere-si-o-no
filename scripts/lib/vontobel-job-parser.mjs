#!/usr/bin/env node
/**
 * Vontobel job parser — Workday (tenant `vontobel`, site Vontobel_External_Career).
 *
 * Vontobel is a Swiss private bank / asset manager headquartered in Zürich.
 * Public careers: https://www.vontobel.com/en-ch/about-vontobel/careers/open-positions/
 * Workday CXS API: https://vontobel.wd3.myworkdayjobs.com/wday/cxs/vontobel/Vontobel_External_Career/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * Canton ZH, postal 8002 (Gotthardstrasse 43, Zürich).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const VONTOBEL_KEY = 'vontobel';
export const VONTOBEL_COMPANY_NAME = 'Vontobel';
export const VONTOBEL_COMPANY_DOMAIN = 'vontobel.com';

const parser = createWorkdaySwissParser({
  companyKey: VONTOBEL_KEY,
  companyName: VONTOBEL_COMPANY_NAME,
  companyDomain: VONTOBEL_COMPANY_DOMAIN,
  tenantHost: 'vontobel.wd3.myworkdayjobs.com',
  sitePath: 'Vontobel_External_Career',
  careerUrl: 'https://www.vontobel.com/en-ch/about-vontobel/careers/open-positions/',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8002',
  sector: 'Banca / Asset Management',
  defaultSourceLang: 'en',
});

export const fetchAllVontobelJobs = parser.fetchAllJobs;
export const isVontobelJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
