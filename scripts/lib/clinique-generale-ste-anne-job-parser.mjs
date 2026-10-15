#!/usr/bin/env node
/**
 * Clinique Générale Ste-Anne (Fribourg, FR) — SMN clinic CDF.
 *
 * Acute private hospital of Swiss Medical Network in Fribourg.
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDF
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 *
 * NOTE: SMN renumbered its per-clinic listing codes — the old `GSM` filter
 * now returns 0 Ste-Anne tiles (reassigned), while `CDF` returns the live
 * Ste-Anne postings (verified: detail pages resolve to Fribourg / 1700 /
 * Rue Hans-Geiler). #1851.
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_GENERALE_STE_ANNE_KEY = 'clinique-generale-ste-anne';
export const CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME = 'Clinique Générale Ste-Anne';
export const CLINIQUE_GENERALE_STE_ANNE_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_GENERALE_STE_ANNE_KEY,
  companyName: CLINIQUE_GENERALE_STE_ANNE_COMPANY_NAME,
  clinicCode: 'CDF',
  companyDomain: CLINIQUE_GENERALE_STE_ANNE_COMPANY_DOMAIN,
  defaultCanton: 'FR',
  defaultCity: 'Fribourg',
  defaultPostalCode: '1700',
  streetAddress: 'Rue Hans-Geiler 6, 1700 Fribourg',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDF',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueGeneraleSteAnneJobs = parser.fetchAllJobs;
export const isCliniqueGeneraleSteAnneJob = parser.isCompanyJob;
export const matchesCliniqueGeneraleSteAnnePosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_GENERALE_STE_ANNE_LISTING_URL = parser.LISTING_URL;
