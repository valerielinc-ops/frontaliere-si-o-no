#!/usr/bin/env node
/**
 * Clinique Générale Ste-Anne (Fribourg, FR) — SMN clinic GSM.
 *
 * Acute private hospital of Swiss Medical Network in Fribourg.
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=GSM
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_GENERALE_STE_ANNE_KEY = 'clinique-generale-ste-anne';
export const CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME = 'Clinique Générale Ste-Anne';
export const CLINIQUE_GENERALE_STE_ANNE_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_GENERALE_STE_ANNE_KEY,
  companyName: CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME,
  clinicCode: 'GSM',
  companyDomain: CLINIQUE_GENERALE_STE_ANNE_COMPANY_DOMAIN,
  defaultCanton: 'FR',
  defaultCity: 'Fribourg',
  defaultPostalCode: '1700',
  streetAddress: 'Rue Hans-Geiler 6, 1700 Fribourg',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=GSM',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueGeneraleSteAnneJobs = parser.fetchAllJobs;
export const isCliniqueGeneraleSteAnneJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_GENERALE_STE_ANNE_LISTING_URL = parser.LISTING_URL;
