#!/usr/bin/env node
/**
 * KONE job parser — Workday (tenant `kone`, site `Careers`).
 *
 * KONE (elevators, escalators, automatic doors) operates in Switzerland as
 * KONE (Schweiz) AG. Public careers: https://www.kone.ch/de/unternehmen/karriere/
 * — its "offene Stellen" links point to https://kone.wd3.myworkdayjobs.com/de-DE/Careers.
 * Workday CXS API: https://kone.wd3.myworkdayjobs.com/wday/cxs/kone/Careers/jobs
 *
 * The former source, the SmartRecruiters company `KONE1`, is not KONE's
 * board: verified live 2026-10-02 it carries a single posting (Belgium) and
 * never had a Swiss one, while this Workday site lists 883 postings in 52
 * countries, 6 of them in Switzerland (Bern, Brüttisellen ×3, Lausanne, Sion)
 * — the Swiss roles also syndicated to jobup.ch under "Kone (Schweiz) AG".
 *
 * The tenant names its country facet `Country` (`locationCountry` → HTTP 400).
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard);
 * a zero is published only when the live board proves Switzerland is absent.
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

export const KONE_KEY = 'kone';
export const KONE_COMPANY_NAME = 'KONE';
export const KONE_COMPANY_DOMAIN = 'kone.com';

export const KONE_WORKDAY_TENANT_HOST = 'kone.wd3.myworkdayjobs.com';
export const KONE_WORKDAY_SITE = 'Careers';

const HQ = getCompanyDefaults(KONE_KEY);

const parser = createWorkdaySwissParser({
  companyKey: KONE_KEY,
  companyName: KONE_COMPANY_NAME,
  companyDomain: KONE_COMPANY_DOMAIN,
  tenantHost: KONE_WORKDAY_TENANT_HOST,
  sitePath: KONE_WORKDAY_SITE,
  careerUrl: 'https://www.kone.ch/de/unternehmen/karriere/',
  defaultCanton: HQ?.canton || 'LU',
  defaultCity: HQ?.city || 'Luzern',
  defaultPostalCode: HQ?.postalCode || '',
  sector: 'Ingegneria / Ascensori',
  defaultSourceLang: 'en',
  countryFacetParameter: 'Country',
  proveSwissAbsentFromLiveBoard: true,
});

export const fetchAllKoneJobs = parser.fetchAllJobs;
export const isKoneJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
