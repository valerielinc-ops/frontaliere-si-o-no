#!/usr/bin/env node
/**
 * PDAG — Psychiatrische Dienste Aargau AG job parser.
 *
 * Public career site: https://jobs.pdag.ch/
 * ATS: Prospective (medium 1000003) — migrated from Umantis tenant 22705.
 *
 * The Umantis listing (recruitingapp-22705.umantis.com) still returns job
 * titles but ALL /Vacancies/{id}/Description/* URLs now 3xx-redirect
 * cross-host to https://jobs.pdag.ch/ (issue #1245). PDAG has fully migrated
 * to Prospective.ch; the canonical job data is served via:
 *   https://ohws.prospective.ch/public/v1/medium/1000003/jobs?lang=de
 *
 * Cantonal psychiatric services for Aargau, headquartered in Königsfelden
 * (Windisch). Covers KPP (psychiatry), ZPP (psychotherapy), addiction
 * medicine, geriatric psychiatry, and child/adolescent services.
 *
 * Fixes: GitHub issue #1740 (0 jobs from dead Umantis detail URLs).
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const PDAG_KEY = 'pdag';
export const PDAG_COMPANY_NAME = 'Psychiatrische Dienste Aargau (PDAG)';
export const PDAG_COMPANY_DOMAIN = 'pdag.ch';

const parser = createProspectiveChParser({
  companyKey: PDAG_KEY,
  companyName: PDAG_COMPANY_NAME,
  companyDomain: PDAG_COMPANY_DOMAIN,
  mediumId: '1000003',
  apiLang: 'de',
  defaultCanton: 'AG',
  defaultCity: 'Windisch',
  defaultPostalCode: '5210',
  publicCareerUrl: 'https://jobs.pdag.ch/',
  defaultSourceLang: 'de',
  // Also trust the Prospective-hosted job pages served from jobs.pdag.ch
  extraTrustedHosts: ['jobs.pdag.ch', 'ohws.prospective.ch'],
});

export const fetchAllPdagJobs = parser.fetchAllJobs;
export const isPdagJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
