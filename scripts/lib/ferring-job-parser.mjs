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
 *
 * The tenant names its country facet `Location_Country`: `locationCountry`
 * and `Country` answer HTTP 400, so the source-level zero proof must continue
 * to use the tenant's own facet. Workday may spell the Swiss primary as
 * `St-Prex, Switzerland`; the official Ferring careers page identifies the
 * same facility as Saint-Prex, so that source descriptor is mapped explicitly
 * rather than inferred from the employer HQ default.
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
  facilityLocations: {
    'St-Prex, Switzerland': {
      locality: 'Saint-Prex',
      evidence: 'https://www.ferring.com/en/working-at-ferring/',
    },
  },
  countryFacetParameter: 'Location_Country',
  proveSwissAbsentFromLiveBoard: true,
});

export const fetchAllFerringJobs = parser.fetchAllJobs;
export const isFerringJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
