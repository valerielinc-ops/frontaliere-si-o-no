#!/usr/bin/env node
/**
 * Concara (Domicil & Spitex Bern) job parser — Prospective.ch (medium 1000278).
 *
 * Concara is the umbrella non-profit foundation born from the 2024 merger of
 * Domicil Bern AG (20+ Berner Alters- und Pflegezentren, ~1'600 employees)
 * and Spitex Bern. The two operating brands keep their identity but share a
 * single careers portal and HR back-office.
 *
 * Public career site: https://jobs.concara.ch/
 *   → SPA whose careercenter ID maps to Prospective medium 1000278:
 *     https://ohws.prospective.ch/public/v1/medium/1000278/jobs?lang=de
 *
 * 53/55 current listings reference both Domicil and Spitex Bern in the
 * company profile — i.e. they are recruited centrally under the Concara
 * group. A handful explicitly mention Friedens-Apotheke (the in-house
 * Domicil pharmacy). Sites span Bern city, Thun, and 20+ Berner Quartiere
 * (Pflege- und Alterszentren), so canton BE is the right default and the
 * per-job postal/city refinement in the shared factory carries the
 * actual location through.
 *
 * Canton BE, default postal 3012 (Domicil HQ, Bremgartenstrasse, Bern).
 *
 * Uses the shared Prospective.ch factory.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const CONCARA_KEY = 'concara';
export const CONCARA_COMPANY_NAME = 'Concara (Domicil & Spitex Bern)';
export const CONCARA_COMPANY_DOMAIN = 'concara.ch';

const parser = createProspectiveChParser({
  companyKey: CONCARA_KEY,
  companyName: CONCARA_COMPANY_NAME,
  companyDomain: CONCARA_COMPANY_DOMAIN,
  mediumId: '1000278',
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Bern',
  defaultPostalCode: '3012',
  publicCareerUrl: 'https://jobs.concara.ch/',
  defaultSourceLang: 'de',
  extraTrustedHosts: [
    'jobs.concara.ch',
    'jobs.domicilbern.ch',
    'www.domicilbern.ch',
    'domicilbern.ch',
    'jobs.spitex-bern.ch',
    'www.spitex-bern.ch',
    'spitex-bern.ch',
  ],
});

export const fetchAllConcaraJobs = parser.fetchAllJobs;
export const isConcaraJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
