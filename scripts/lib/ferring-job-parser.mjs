#!/usr/bin/env node
/**
 * Ferring Pharmaceuticals job parser — Workday (tenant `ferring`, site `Ferring`).
 *
 * Ferring is a Swiss (globally-operating) biopharmaceutical company
 * headquartered in Saint-Prex, canton Vaud.
 * Public careers: https://www.ferring.com/en/working-at-ferring
 * Workday CXS API: https://ferring.wd3.myworkdayjobs.com/wday/cxs/ferring/Ferring/jobs
 *
 * Swiss-scoped via the shared Workday factory (country facet + foreign guard).
 * Canton VD, postal 1162 (Chemin de la Ligne 7, Saint-Prex).
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

export const FERRING_KEY = 'ferring';
export const FERRING_COMPANY_NAME = 'Ferring Pharmaceuticals';
export const FERRING_COMPANY_DOMAIN = 'ferring.com';

const parser = createWorkdaySwissParser({
  companyKey: FERRING_KEY,
  companyName: FERRING_COMPANY_NAME,
  companyDomain: FERRING_COMPANY_DOMAIN,
  tenantHost: 'ferring.wd3.myworkdayjobs.com',
  sitePath: 'Ferring',
  careerUrl: 'https://www.ferring.com/en/working-at-ferring',
  defaultCanton: 'VD',
  defaultCity: 'Saint-Prex',
  defaultPostalCode: '1162',
  sector: 'Farmaceutica',
  defaultSourceLang: 'en',
});

export const fetchAllFerringJobs = parser.fetchAllJobs;
export const isFerringJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
