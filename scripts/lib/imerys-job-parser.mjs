#!/usr/bin/env node
/**
 * Imerys job parser — Workday (tenant `imerys`, site `IMERYS-Careers`).
 *
 * Imerys (mineral-based specialty solutions) runs its Swiss operations in
 * Ticino: the Imerys Graphite & Carbon plant in Bodio and offices in Bironico.
 * Public careers: https://www.imerys.com/careers — its `/careers/jobs/req-NNNNN`
 * pages are a front for the Workday requisitions, and the corporate site sits
 * behind an AWS WAF JavaScript challenge (HTTP 202, empty body), so it is not
 * a readable source.
 * Workday CXS API: https://imerys.wd3.myworkdayjobs.com/wday/cxs/imerys/IMERYS-Careers/jobs
 *
 * The former source, the SmartRecruiters company `Imerys`, no longer exists:
 * `/v1/companies/Imerys/departments` answers 404 and the postings endpoint
 * returns the `{"totalFound":0}` envelope SmartRecruiters gives any unknown
 * identifier. Verified live 2026-10-02: this Workday site lists 119 postings in
 * 23 countries, 3 of them in Switzerland (Bironico ×2, Bodio ×1), while the
 * crawler had been reporting zero.
 *
 * The tenant names its country facet `Country` (`locationCountry` → HTTP 400).
 * The second site on the tenant, `Imerys_Career2`, carries 35 postings and no
 * Swiss value in its country facet.
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard);
 * a zero is published only when the live board proves Switzerland is absent.
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const IMERYS_KEY = 'imerys';
export const IMERYS_COMPANY_NAME = 'Imerys';
export const IMERYS_COMPANY_DOMAIN = 'imerys.com';

export const IMERYS_WORKDAY_TENANT_HOST = 'imerys.wd3.myworkdayjobs.com';
export const IMERYS_WORKDAY_SITE = 'IMERYS-Careers';

const parser = createWorkdaySwissParser({
  companyKey: IMERYS_KEY,
  companyName: IMERYS_COMPANY_NAME,
  companyDomain: IMERYS_COMPANY_DOMAIN,
  tenantHost: IMERYS_WORKDAY_TENANT_HOST,
  sitePath: IMERYS_WORKDAY_SITE,
  careerUrl: 'https://www.imerys.com/careers',
  defaultCanton: 'TI',
  defaultCity: 'Bodio',
  defaultPostalCode: '6743',
  sector: 'Industria mineraria / Materiali speciali',
  defaultSourceLang: 'en',
  countryFacetParameter: 'Country',
  proveSwissAbsentFromLiveBoard: true,
});

export const fetchAllImerysJobs = parser.fetchAllJobs;
export const isImerysJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
