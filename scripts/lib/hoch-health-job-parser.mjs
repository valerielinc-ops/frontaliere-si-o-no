#!/usr/bin/env node
/**
 * HOCH Health Ostschweiz job parser — SAP SuccessFactors Career Site Builder (CSB).
 *
 * Public career site:  https://jobs.h-och.ch/search/
 * Corporate site:      https://www.h-och.ch/
 * SF tenant code:      hochhealthostschweiz (path `/company/hochhealthostschweiz`)
 *
 * HOCH Health Ostschweiz is the merged Kantonsspital St.Gallen group spanning
 * the St.Gallen, Grabs, Walenstadt, Altstätten, Flawil, Rorschach and
 * Wattwil sites in the cantons SG/AR/GL. It absorbed the former Spitalverbund
 * AR and the Spitalregion Rheintal Werdenberg Sarganserland (SR RWS). One of
 * the largest healthcare employers in eastern Switzerland (~10000 employees).
 *
 * See `scripts/lib/successfactors-shared-job-parser-common.mjs` for the
 * platform details.
 */
import { createSuccessFactorsParser } from './successfactors-shared-job-parser-common.mjs';

export const HOCH_HEALTH_KEY = 'hoch-health';
export const HOCH_HEALTH_COMPANY_NAME = 'HOCH Health Ostschweiz';
export const HOCH_HEALTH_COMPANY_DOMAIN = 'h-och.ch';

const parser = createSuccessFactorsParser({
  companyKey: HOCH_HEALTH_KEY,
  companyName: HOCH_HEALTH_COMPANY_NAME,
  companyDomain: HOCH_HEALTH_COMPANY_DOMAIN,
  sfCompanyId: 'hochhealthostschweiz',
  publicCareerUrl: 'https://jobs.h-och.ch',
  defaultCanton: 'SG',
  defaultCity: 'St. Gallen',
  defaultPostalCode: '9007',
  defaultSourceLang: 'de',
  sourceLabel: 'HOCH Health Ostschweiz Dedicated Parser (SuccessFactors CSB)',
});

export const fetchAllHochHealthJobs = parser.fetchAllJobs;
export const isHochHealthJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
