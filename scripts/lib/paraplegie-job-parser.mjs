#!/usr/bin/env node
/**
 * Schweizer Paraplegiker-Gruppe (SPG) job parser — Prospective.ch (medium 1001777).
 *
 * Umbrella organisation in Nottwil LU covering:
 *   - Schweizer Paraplegiker-Zentrum (SPZ, rehabilitation clinic)
 *   - Schweizer Paraplegiker-Stiftung (SPS, foundation)
 *   - Schweizer Paraplegiker-Vereinigung (SPV)
 *   - Schweizer Paraplegiker-Forschung (SPF)
 *   - ParaHelp (homecare for paraplegic patients)
 *   - Active Communication AG (assistive tech, Steinhausen ZG)
 *   - Orthotec AG (orthopaedic technology)
 *   - Sirmed AG (Swiss Institute of Emergency Medicine, Nottwil)
 *   - Hotel Sempachersee
 *
 * MIGRATION (issue #1877): SPG's vacancies moved off the old Umantis tenant
 * (recruitingapp-2782.umantis.com) — whose detail URLs now 302-redirect
 * cross-host to a dead page — onto a Prospective.ch career center hosted at
 * https://jobs.paraplegie.ch/offene-stellen/ . That listing is SSR/SPA-backed
 * by the Prospective public JSON API:
 *
 *   https://ohws.prospective.ch/public/v1/medium/1001777/jobs?lang=de
 *
 * The numeric medium id (1001777) was recovered from the career-center favicon
 * URL embedded in the listing shell HTML
 * (ohws.prospective.ch/careercenter/1001777/assets/favicon.ico) and confirmed
 * live: the endpoint returns SPG's full job set (medium_id 1001777, ~40 jobs)
 * with rich `sza_*` body fields and `links.directlink` pointing at
 * jobs.paraplegie.ch/offene-stellen/<slug>/<uuid> detail pages. The legacy
 * directlink/careercenter asset id 1005025002 is NOT the medium id (a
 * medium/1005025002 query returns HTTP 400).
 *
 * All sub-entities publish through this single Prospective tenant — the
 * operating unit surfaces in attribute 20 / sza_company. Per-job canton is
 * inferred from the workplace city (Nottwil → LU, Steinhausen → ZG) by the
 * shared factory, falling back to LU (Nottwil HQ).
 *
 * Uses the shared Prospective.ch factory (same path as coop, balgrist, claraspital…).
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const PARAPLEGIE_KEY = 'paraplegie';
export const PARAPLEGIE_COMPANY_NAME = 'Schweizer Paraplegiker-Gruppe';
export const PARAPLEGIE_COMPANY_DOMAIN = 'paraplegie.ch';

const parser = createProspectiveChParser({
  companyKey: PARAPLEGIE_KEY,
  companyName: PARAPLEGIE_COMPANY_NAME,
  companyDomain: PARAPLEGIE_COMPANY_DOMAIN,
  mediumId: '1001777',
  apiLang: 'de',
  defaultCanton: 'LU',
  defaultCity: 'Nottwil',
  defaultPostalCode: '6207',
  publicCareerUrl: 'https://jobs.paraplegie.ch/offene-stellen/',
  defaultSourceLang: 'de',
  // The career center detail pages live on jobs.paraplegie.ch (Prospective
  // directlink target); trust that host so emitted apply/detail URLs pass the
  // trusted-domain gate.
  extraTrustedHosts: ['jobs.paraplegie.ch'],
});

export const fetchAllParaplegieJobs = parser.fetchAllJobs;
export const isParaplegieJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
