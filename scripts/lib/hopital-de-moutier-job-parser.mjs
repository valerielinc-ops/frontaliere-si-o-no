#!/usr/bin/env node
/**
 * Hôpital de Moutier (Moutier, BE) — SMN clinic.
 *
 * Acute hospital of Swiss Medical Network in Moutier (Jura bernois, BE),
 * part of the "Réseau de l'Arc" network (with Hôpital de Saint-Imier and
 * Medizinisches Zentrum Biel).
 *
 * Jobs come from the public SmartRecruiters postings API
 * (SwissMedicalNetwork1 tenant), filtered by ATS department:
 *   - department "Hôpital de Moutier" (the clinic's own postings), plus
 *   - network-wide "Réseau de l'Arc" postings located in Moutier city
 *     (they sit at the hospital's Rue Beausite site but are tagged with
 *     the umbrella department).
 *
 * NOTE (July 2026, issue #3857): the legacy listing filter `?clinic=MZB`
 * drifted — SMN re-mapped `MZB` to "Medizinisches Zentrum Biel" and the
 * clinic-code filter now matches ATS Brands, so it renders zero tiles
 * for this hospital. `clinicCode` below is kept for the public career
 * URL and the `source` label only.
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
  // Umbrella department of the Jura Arc network: attribute its postings to
  // this hospital only when they are physically in Moutier.
  cityScopedDepartmentLabels: ["Réseau de l'Arc"],
});

export const fetchAllHopitalDeMoutierJobs = parser.fetchAllJobs;
export const isHopitalDeMoutierJob = parser.isCompanyJob;
export const matchesHopitalDeMoutierPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const HOPITAL_DE_MOUTIER_LISTING_URL = parser.LISTING_URL;
