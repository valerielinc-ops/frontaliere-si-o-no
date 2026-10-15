#!/usr/bin/env node
/**
 * Clinique de Montchoisi (Lausanne, VD) — SMN clinic CDM.
 *
 * Acute private hospital of Swiss Medical Network in Lausanne (Vaud).
 * Listing endpoint:
 *
 *   https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDM
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const CLINIQUE_DE_MONTCHOISI_KEY = 'clinique-de-montchoisi';
export const CLINIQUE_DE_MONTCHOISI_COMPANY_NAME = 'Clinique de Montchoisi';
export const CLINIQUE_DE_MONTCHOISI_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: CLINIQUE_DE_MONTCHOISI_KEY,
  companyName: CLINIQUE_DE_MONTCHOISI_COMPANY_NAME,
  clinicCode: 'CDM',
  companyDomain: CLINIQUE_DE_MONTCHOISI_COMPANY_DOMAIN,
  defaultCanton: 'VD',
  defaultCity: 'Lausanne',
  defaultPostalCode: '1006',
  streetAddress: 'Chemin des Allinges 10, 1006 Lausanne',
  publicCareerUrl: 'https://www.swissmedical.net/fr/carriere/offres-emploi?clinic=CDM',
  defaultSourceLang: 'fr',
  lang: 'fr',
});

export const fetchAllCliniqueDeMontchoisiJobs = parser.fetchAllJobs;
export const isCliniqueDeMontchoisiJob = parser.isCompanyJob;
export const matchesCliniqueDeMontchoisiPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const CLINIQUE_DE_MONTCHOISI_LISTING_URL = parser.LISTING_URL;
