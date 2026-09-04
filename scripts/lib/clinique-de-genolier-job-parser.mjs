#!/usr/bin/env node
/**
 * Clinique de Genolier (Genolier, VD) — SMN clinic CDG.
 *
 * Flagship private hospital of Swiss Medical Network in Genolier (Vaud).
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDG
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_DE_GENOLIER_KEY = 'clinique-de-genolier';
export const CLINIQUE_DE_GENOLIER_COMPANY_NAME = 'Clinique de Genolier';
export const CLINIQUE_DE_GENOLIER_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_DE_GENOLIER_KEY,
  companyName: CLINIQUE_DE_GENOLIER_COMPANY_NAME,
  clinicCode: 'CDG',
  companyDomain: CLINIQUE_DE_GENOLIER_COMPANY_DOMAIN,
  defaultCanton: 'VD',
  defaultCity: 'Genolier',
  defaultPostalCode: '1272',
  streetAddress: 'Route du Muids 3, 1272 Genolier',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDG',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueDeGenolierJobs = parser.fetchAllJobs;
export const isCliniqueDeGenolierJob = parser.isCompanyJob;
export const matchesCliniqueDeGenolierPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_DE_GENOLIER_LISTING_URL = parser.LISTING_URL;
