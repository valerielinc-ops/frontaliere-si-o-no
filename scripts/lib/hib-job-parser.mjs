#!/usr/bin/env node
/**
 * Hôpital Intercantonal de la Broye (HIB) job parser.
 *
 * Public career site:  https://emploi.hopital-broye.ch/
 * API:                 https://emploi.hopital-broye.ch/api/offers (JSON)
 *
 * Intercantonal hospital VD/FR, ~800 employees.
 * Sites: Payerne (acute), Estavayer-le-Lac, Domdidier.
 *
 * Uses the shared VD emploi platform parser.
 */
import { createVdEmploiPlatformParser } from './vd-emploi-platform-common.mjs';

export const HIB_KEY = 'hib-broye';
export const HIB_COMPANY_NAME = 'Hôpital Intercantonal de la Broye (HIB)';
export const HIB_COMPANY_DOMAIN = 'hopital-broye.ch';

const parser = createVdEmploiPlatformParser({
  companyKey: HIB_KEY,
  companyName: HIB_COMPANY_NAME,
  companyDomain: HIB_COMPANY_DOMAIN,
  baseUrl: 'https://emploi.hopital-broye.ch',
  defaultCanton: 'VD',
  defaultCity: 'Payerne',
  defaultPostalCode: '1530',
  defaultSourceLang: 'fr',
  sourceLabel: 'HIB Dedicated Parser (VD emploi platform)',
});

export const fetchAllHibJobs = parser.fetchAllJobs;
export const isHibJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
