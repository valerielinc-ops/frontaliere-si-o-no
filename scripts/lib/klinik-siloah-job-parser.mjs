#!/usr/bin/env node
/**
 * Privatklinik Siloah (Gümligen, BE) — SMN clinic PKS.
 *
 * Acute private hospital + birth centre of Swiss Medical Network in
 * Gümligen near Bern.
 *
 * Jobs come from the public SmartRecruiters postings API
 * (SwissMedicalNetwork1 tenant), filtered by ATS department
 * "Privatklinik Siloah". The BE sister units (Ärztezentrum Siloah
 * Liebefeld, Ärztezentrum Siloah Murten) are distinct departments and
 * remain out of scope — this parser is Siloah-Gümligen only.
 *
 * NOTE (July 2026, issue #3859): the legacy listing filter `?clinic=PKS`
 * drifted (clinic codes now match ATS Brands and the listing renders
 * client-side state server-side inconsistently), so the factory switched
 * to the postings API. `clinicCode` below is kept for the public career
 * URL and the `source` label only. Zero jobs is a legitimate result when
 * the clinic has no open positions in the ATS.
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const KLINIK_SILOAH_KEY = 'klinik-siloah';
export const KLINIK_SILOAH_COMPANY_NAME = 'Privatklinik Siloah';
export const KLINIK_SILOAH_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: KLINIK_SILOAH_KEY,
  companyName: KLINIK_SILOAH_COMPANY_NAME,
  clinicCode: 'PKS',
  companyDomain: KLINIK_SILOAH_COMPANY_DOMAIN,
  defaultCanton: 'BE',
  defaultCity: 'Gümligen',
  defaultPostalCode: '3073',
  streetAddress: 'Worbstrasse 324, 3073 Gümligen',
  publicCareerUrl: 'https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKS',
  defaultSourceLang: 'de',
});

export const fetchAllKlinikSiloahJobs = parser.fetchAllJobs;
export const isKlinikSiloahJob = parser.isCompanyJob;
export const matchesKlinikSiloahPosting = parser.matchesClinicPosting;
export const isTrustedDomain = parser.isTrustedDomain;
export const KLINIK_SILOAH_LISTING_URL = parser.LISTING_URL;
