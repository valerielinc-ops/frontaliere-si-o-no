#!/usr/bin/env node
/**
 * Gesundheitszentrum Dielsdorf (GZ Dielsdorf) job parser
 * — Prospective.ch medium 1005824.
 *
 * Background:
 *   Gesundheitszentrum Dielsdorf is the regional non-profit health
 *   organisation in the Zürcher Unterland (Dielsdorf district), running a
 *   nursing-home network, Spitex home-care services and assisted-living
 *   programmes. ~20 open positions across Pflege HF/FAGE, palliative care,
 *   hauswirtschaft and administration.
 *
 *   Distinct from `gesundheitszentrum-fricktal-job-parser.mjs` (Fricktal/AG)
 *   and the various Spitex tenants already covered.
 *
 * Public career site: https://www.gz-dielsdorf.ch/jobs
 *   → iframes a Prospective careercenter (1005824). Apply backend is
 *     Umantis (recruitingapp-2896.umantis.com — "Bewerbermanagement GZ
 *     Dielsdorf"), but the public listing API is Prospective like other
 *     healthcare tenants in this codebase.
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1005824/jobs?lang=de
 *
 * Canton ZH, postal 8157 (Dielsdorf).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const GZ_DIELSDORF_KEY = 'gz-dielsdorf';
export const GZ_DIELSDORF_COMPANY_NAME = 'Gesundheitszentrum Dielsdorf';
export const GZ_DIELSDORF_COMPANY_DOMAIN = 'gz-dielsdorf.ch';

const parser = createProspectiveChParser({
  companyKey: GZ_DIELSDORF_KEY,
  companyName: GZ_DIELSDORF_COMPANY_NAME,
  companyDomain: GZ_DIELSDORF_COMPANY_DOMAIN,
  mediumId: '1005824',
  apiLang: 'de',
  defaultCanton: 'ZH',
  defaultCity: 'Dielsdorf',
  defaultPostalCode: '8157',
  publicCareerUrl: 'https://www.gz-dielsdorf.ch/jobs',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'gz-dielsdorf.ch',
    'jobs.gz-dielsdorf.ch',
    'recruitingapp-2896.umantis.com',
  ],
});

export const fetchAllGzDielsdorfJobs = parser.fetchAllJobs;
export const isGzDielsdorfJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
