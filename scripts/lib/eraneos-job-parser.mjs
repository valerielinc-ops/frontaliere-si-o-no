#!/usr/bin/env node
/**
 * Eraneos job parser — Workday (tenant `eraneos`, site
 * Eraneos_External_Career_Site).
 *
 * Eraneos Switzerland AG is a genuine European IT/digital transformation
 * consulting firm (formerly the Ordina/Quint spinoff group) headquartered
 * in Zürich, with a secondary Swiss office in Lausanne. Direct employer —
 * no staffing-agency risk.
 *
 * Public careers: https://www.eraneos.com/ch/careers/
 * Workday CXS API: https://eraneos.wd3.myworkdayjobs.com/wday/cxs/eraneos/Eraneos_External_Career_Site/jobs
 *
 * The `locationCountry` facet is rejected by this tenant (HTTP 400), so the
 * shared factory falls back to the unfiltered board + strict per-listing
 * Swiss gate. Confirmed live: all 51 postings are CH-only (Zürich/Lausanne),
 * `hiringOrganization.name` = "Eraneos Switzerland AG" on job detail.
 *
 * Note: nearly every Eraneos posting reports `locationsText` as a
 * multi-site rollup ("2 Locations", "3 Locations") rather than a single
 * city, which the strict-mode gate cannot resolve on its own — this is what
 * motivated the `externalPath`-based location fallback added to
 * `workday-swiss-job-parser-common.mjs` (Workday's stable
 * `/job/{Location}/...` path convention always carries the primary work
 * city, verified on job detail: `jobRequisitionLocation.descriptor`).
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign
 * guard + externalPath location fallback).
 * Canton ZH, postal 8005 (HQ: Josefstrasse 219, 8005 Zürich — confirmed from
 * Eraneos Switzerland's own imprint page).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const ERANEOS_KEY = 'eraneos';
export const ERANEOS_COMPANY_NAME = 'Eraneos Switzerland AG';
export const ERANEOS_COMPANY_DOMAIN = 'eraneos.com';

const parser = createWorkdaySwissParser({
  companyKey: ERANEOS_KEY,
  companyName: ERANEOS_COMPANY_NAME,
  companyDomain: ERANEOS_COMPANY_DOMAIN,
  tenantHost: 'eraneos.wd3.myworkdayjobs.com',
  sitePath: 'Eraneos_External_Career_Site',
  careerUrl: 'https://www.eraneos.com/ch/careers/',
  defaultCanton: 'ZH',
  defaultCity: 'Zürich',
  defaultPostalCode: '8005',
  sector: 'Consulenza IT / Digital',
  defaultSourceLang: 'en',
});

export const fetchAllEraneosJobs = parser.fetchAllJobs;
export const isEraneosJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
