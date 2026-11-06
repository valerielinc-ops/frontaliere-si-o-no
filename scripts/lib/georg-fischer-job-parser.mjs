#!/usr/bin/env node
/**
 * Georg Fischer (GF) job parser — Workday (tenant `georgfischer`, site GeorgFischer_Careers).
 *
 * GF is a Swiss industrial group (GF Piping Systems, GF Casting Solutions, GF
 * Machining Solutions) headquartered in Schaffhausen. Public careers:
 * https://www.georgfischer.com/en/careers.html
 * Workday CXS API: https://georgfischer.wd103.myworkdayjobs.com/wday/cxs/georgfischer/GeorgFischer_Careers/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard) —
 * the global board lists many non-CH roles which are filtered out.
 * Canton SH, postal 8201 (Amsler-Laffon-Strasse 9, Schaffhausen).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const GEORG_FISCHER_KEY = 'georg-fischer';
export const GEORG_FISCHER_COMPANY_NAME = 'Georg Fischer';
export const GEORG_FISCHER_COMPANY_DOMAIN = 'georgfischer.com';

const parser = createWorkdaySwissParser({
  companyKey: GEORG_FISCHER_KEY,
  companyName: GEORG_FISCHER_COMPANY_NAME,
  companyDomain: GEORG_FISCHER_COMPANY_DOMAIN,
  tenantHost: 'georgfischer.wd103.myworkdayjobs.com',
  sitePath: 'GeorgFischer_Careers',
  careerUrl: 'https://www.georgfischer.com/en/careers.html',
  defaultCanton: 'SH',
  defaultCity: 'Schaffhausen',
  defaultPostalCode: '8201',
  sector: 'Industria / Manifattura',
  defaultSourceLang: 'en',
});

export const fetchAllGeorgFischerJobs = parser.fetchAllJobs;
export const isGeorgFischerJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
