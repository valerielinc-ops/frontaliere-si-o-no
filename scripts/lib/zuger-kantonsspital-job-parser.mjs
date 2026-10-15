#!/usr/bin/env node
/**
 * Zuger Kantonsspital (ZG) job parser — rexx-systems ATS on `jobs.zgks.ch`.
 *
 * Public career site: https://www.zugerkantonsspital.ch/karriere/offene-stellen/
 *   → links to https://jobs.zgks.ch/stellenangebote.html (rexx-systems portal)
 *
 * ~11 open positions across nursing, medical, MPA, and operations at the
 * 5,800-employee Baar campus. Single canton (ZG).
 *
 * Uses the shared rexx-systems factory.
 */
import { createRexxSystemsParser } from './rexx-systems-job-parser-common.mjs';

export const ZUGER_KANTONSSPITAL_KEY = 'zuger-kantonsspital';
export const ZUGER_KANTONSSPITAL_COMPANY_NAME = 'Zuger Kantonsspital';
export const ZUGER_KANTONSSPITAL_COMPANY_DOMAIN = 'zgks.ch';

const parser = createRexxSystemsParser({
  companyKey: ZUGER_KANTONSSPITAL_KEY,
  companyName: ZUGER_KANTONSSPITAL_COMPANY_NAME,
  companyDomain: ZUGER_KANTONSSPITAL_COMPANY_DOMAIN,
  atsHost: 'jobs.zgks.ch',
  defaultCanton: 'ZG',
  defaultCity: 'Baar',
  defaultPostalCode: '6340',
  publicCareerUrl: 'https://www.zugerkantonsspital.ch/karriere/offene-stellen/',
  defaultSourceLang: 'de',
});

export const fetchAllZugerKantonsspitalJobs = parser.fetchAllJobs;
export const isZugerKantonsspitalJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
