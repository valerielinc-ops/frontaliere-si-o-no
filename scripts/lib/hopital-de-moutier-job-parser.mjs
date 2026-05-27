#!/usr/bin/env node
/**
 * Hôpital de Moutier (Moutier, BE) — SMN clinic MZB.
 *
 * Acute hospital of Swiss Medical Network in Moutier (Jura bernois, BE).
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=MZB
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const HOPITAL_DE_MOUTIER_KEY = 'hopital-de-moutier';
export const HOPITAL_DE_MOUTIER_COMPANY_NAME = 'Hôpital de Moutier';
export const HOPITAL_DE_MOUTIER_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: HOPITAL_DE_MOUTIER_KEY,
  companyName: HOPITAL_DE_MOUTIER_COMPANY_NAME,
  clinicCode: 'MZB',
  companyDomain: HOPITAL_DE_MOUTIER_COMPANY_DOMAIN,
  defaultCanton: 'BE',
  defaultCity: 'Moutier',
  defaultPostalCode: '2740',
  streetAddress: 'Beausite 49, 2740 Moutier',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=MZB',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllHopitalDeMoutierJobs = parser.fetchAllJobs;
export const isHopitalDeMoutierJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
export const HOPITAL_DE_MOUTIER_LISTING_URL = parser.LISTING_URL;
