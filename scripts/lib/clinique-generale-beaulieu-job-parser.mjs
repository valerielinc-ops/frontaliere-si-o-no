#!/usr/bin/env node
/**
 * Clinique Générale-Beaulieu (Genève, GE) — SMN clinic CGB.
 *
 * Acute private hospital of Swiss Medical Network in Geneva.
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CGB
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_GENERALE_BEAULIEU_KEY = 'clinique-generale-beaulieu';
export const CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME = 'Clinique Générale-Beaulieu';
export const CLINIQUE_GENERALE_BEAULIEU_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_GENERALE_BEAULIEU_KEY,
  companyName: CLINIQUE_GENERALE_BEAULIEU_COMPANY_NAME,
  clinicCode: 'CGB',
  companyDomain: CLINIQUE_GENERALE_BEAULIEU_COMPANY_DOMAIN,
  defaultCanton: 'GE',
  defaultCity: 'Genève',
  defaultPostalCode: '1206',
  streetAddress: 'Chemin de Beau-Soleil 20, 1206 Genève',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CGB',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueGeneraleBeaulieuJobs = parser.fetchAllJobs;
export const isCliniqueGeneraleBeaulieuJob = parser.isCompanyJob;
export const matchesCliniqueGeneraleBeaulieuPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_GENERALE_BEAULIEU_LISTING_URL = parser.LISTING_URL;
