#!/usr/bin/env node
/**
 * Clinique de Valère (Sion, VS) — SMN clinic CDV.
 *
 * Private hospital of Swiss Medical Network in Sion (Valais).
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDV
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_DE_VALERE_KEY = 'clinique-de-valere';
export const CLINIQUE_DE_VALERE_COMPANY_NAME = 'Clinique de Valère';
export const CLINIQUE_DE_VALERE_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_DE_VALERE_KEY,
  companyName: CLINIQUE_DE_VALERE_COMPANY_NAME,
  clinicCode: 'CDV',
  companyDomain: CLINIQUE_DE_VALERE_COMPANY_DOMAIN,
  defaultCanton: 'VS',
  defaultCity: 'Sion',
  defaultPostalCode: '1950',
  streetAddress: 'Rue Pré-Fleuri 16, 1950 Sion',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDV',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueDeValereJobs = parser.fetchAllJobs;
export const isCliniqueDeValereJob = parser.isCompanyJob;
export const matchesCliniqueDeValerePosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_DE_VALERE_LISTING_URL = parser.LISTING_URL;
