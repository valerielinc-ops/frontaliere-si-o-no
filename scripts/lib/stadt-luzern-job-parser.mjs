#!/usr/bin/env node
/**
 * Stadt Luzern (municipal administration) job parser — Prospective.ch
 * (medium 1005002).
 *
 * Discovery-tag verification (row 46, issue #3342): queue tagged host
 * `ohws.prospective.ch`, ATS "Prospective/Refline", ~25 roles — confirmed
 * ACCURATE on live check (unusual for this campaign; most discovery tags
 * need correction). Public careers marketing site is
 * `https://jobs.stadtluzern.ch/stellen/offene-stellen-stadt-luzern/`
 * (WordPress, theme `stlu-jobs`), which links out to the actual applicant
 * portal `https://job.stadtluzern.ch/` (singular "job", distinct from the
 * plural marketing-site domain). That portal's assets are served from
 * `ohws.prospective.ch/careercenter/1005002/...`, confirming tenant/medium
 * ID 1005002. Verified live: `GET
 * https://ohws.prospective.ch/public/v1/medium/1005002/jobs?lang=de`
 * returns `medium_id: 1005002`, 32 real jobs at verification time (title
 * "Stadt Luzern: Stellenportal" on the portal page).
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1005002/jobs
 * Public career site: https://jobs.stadtluzern.ch/stellen/offene-stellen-stadt-luzern/
 * Applicant portal: https://job.stadtluzern.ch/
 *
 * Direct municipal employer (city administration), not a staffing agency.
 * Genuinely city-wide, single-location: every listing observed at
 * verification time carries its own real `sza_location.zip` +
 * `sza_location.street` (offices spread across Luzern, e.g. Hirschengraben
 * 17 / 6003, Industriestrasse 6 / 6002), all within canton LU. Roles span
 * five "Berufswelten" departments (`attributes['10']`): Planung, Bau &
 * Unterhalt; Bildung, Kultur & Soziales; Informationstechnologien;
 * Mobilität & Umwelt; Recht, Finanzen & Controlling.
 *
 * NOTE — distinct sibling tenant: `Volksschule Stadt Luzern` (the city's
 * school administration) is a SEPARATE Prospective tenant (medium 1005619)
 * on the same `job.stadtluzern.ch` careercenter family — not a duplicate
 * of this crawler; different mediumId means no cross-matching risk via
 * the shared factory's `isCompanyJob`.
 *
 * Uses shared Prospective.ch factory. This tenant is public administration,
 * not healthcare, so `sector`/`defaultCategory` are overridden (factory
 * defaults to 'Sanità / Ospedali' for its original hospital consumers —
 * see prospective-ch-job-parser-common.mjs). Convention matches other
 * Swiss public-sector dedicated crawlers (`kanton-gr-job-parser.mjs`,
 * `gemeinde-st-moritz-job-parser.mjs`): sector = 'Amministrazione
 * Pubblica'.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const STADT_LUZERN_KEY = 'stadt-luzern';
export const STADT_LUZERN_COMPANY_NAME = 'Stadt Luzern';
export const STADT_LUZERN_COMPANY_DOMAIN = 'stadtluzern.ch';

const parser = createProspectiveChParser({
  companyKey: STADT_LUZERN_KEY,
  companyName: STADT_LUZERN_COMPANY_NAME,
  companyDomain: STADT_LUZERN_COMPANY_DOMAIN,
  mediumId: '1005002',
  apiLang: 'de',
  defaultCanton: 'LU',
  defaultCity: 'Luzern',
  defaultPostalCode: '6003',
  defaultStreetAddress: 'Hirschengraben 17',
  publicCareerUrl: 'https://jobs.stadtluzern.ch/stellen/offene-stellen-stadt-luzern/',
  defaultSourceLang: 'de',
  extraTrustedHosts: ['job.stadtluzern.ch', 'jobs.stadtluzern.ch'],
  sector: 'Amministrazione Pubblica',
  defaultCategory: 'Amministrazione Pubblica',
});

export const fetchAllStadtLuzernJobs = parser.fetchAllJobs;
export const isStadtLuzernJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
