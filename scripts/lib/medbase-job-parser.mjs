#!/usr/bin/env node
/**
 * Medbase job parser — Workday (tenant `medbase`, wd502, site `Medbase_jobs`).
 *
 * Medbase is a Swiss network of medical centers, physiotherapy practices and
 * pharmacies (part of the Migros / Zur Rose group) with 90+ locations across
 * Switzerland. Direct employer, no staffing-agency risk.
 *
 * Public careers: https://jobs.medbase.ch/offene-stellen/
 * Workday public site: https://wd502.myworkdaysite.com/de-CH/recruiting/medbase/Medbase_jobs
 * Workday CXS API: https://medbase.wd502.myworkdayjobs.com/wday/cxs/medbase/Medbase_jobs/jobs
 *
 * This tenant rejects the `locationCountry` facet (HTTP 400) — the shared
 * factory falls back to the unfiltered board + strict per-listing Swiss-canton
 * gate automatically. Nearly all listings carry a single-city `locationsText`
 * (Amriswil, Zürich, Winterthur, …); a small minority roll up to "N Locations"
 * (e.g. group-wide apprenticeship/training postings), recovered via the
 * `externalPath` primary-location fallback in the shared factory.
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * HQ: Schützenstrasse 3, 8400 Winterthur, Kanton ZH.
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const MEDBASE_KEY = 'medbase';
export const MEDBASE_COMPANY_NAME = 'Medbase';
export const MEDBASE_COMPANY_DOMAIN = 'medbase.ch';

const parser = createWorkdaySwissParser({
  companyKey: MEDBASE_KEY,
  companyName: MEDBASE_COMPANY_NAME,
  companyDomain: MEDBASE_COMPANY_DOMAIN,
  tenantHost: 'medbase.wd502.myworkdayjobs.com',
  sitePath: 'Medbase_jobs',
  careerUrl: 'https://jobs.medbase.ch/offene-stellen/',
  defaultCanton: 'ZH',
  defaultCity: 'Winterthur',
  defaultPostalCode: '8400',
  sector: 'Sanità / Farmacie',
  defaultSourceLang: 'de',
});

export const fetchAllMedbaseJobs = parser.fetchAllJobs;
export const isMedbaseJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
