#!/usr/bin/env node
/**
 * Galderma job parser — Workday (tenant `galderma`, site External).
 *
 * Galderma is a dermatology company headquartered in Zug, with Swiss R&D in
 * Lausanne (EPFL). Public careers: https://www.galderma.com/careers
 * Workday CXS API: https://galderma.wd3.myworkdayjobs.com/wday/cxs/galderma/External/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard) —
 * the global board (~350 roles) is filtered down to the Swiss openings.
 * Canton ZG, postal 6300 (Zugerstrasse, Zug).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const GALDERMA_KEY = 'galderma';
export const GALDERMA_COMPANY_NAME = 'Galderma';
export const GALDERMA_COMPANY_DOMAIN = 'galderma.com';

const parser = createWorkdaySwissParser({
  companyKey: GALDERMA_KEY,
  companyName: GALDERMA_COMPANY_NAME,
  companyDomain: GALDERMA_COMPANY_DOMAIN,
  tenantHost: 'galderma.wd3.myworkdayjobs.com',
  sitePath: 'External',
  careerUrl: 'https://www.galderma.com/careers',
  defaultCanton: 'ZG',
  defaultCity: 'Zug',
  defaultPostalCode: '6300',
  sector: 'Pharma / Dermatologia',
  defaultSourceLang: 'en',
});

export const fetchAllGaldermaJobs = parser.fetchAllJobs;
export const isGaldermaJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
