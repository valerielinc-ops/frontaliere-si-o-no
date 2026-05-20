#!/usr/bin/env node
/**
 * Privatklinik Siloah (Gümligen, BE) — SMN clinic PKS.
 *
 * Acute private hospital + birth centre of Swiss Medical Network in
 * Gümligen near Bern. Listing endpoint:
 *
 *   https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKS
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 * The umbrella ATS also exposes BE sister units (Ärztezentrum Siloah
 * Liebefeld = ASL, Ärztezentrum Siloah Murten = ASM) under distinct
 * clinic codes — those remain out of scope here, this parser is
 * Siloah-Gümligen only.
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
export const isTrustedDomain = parser.isTrustedDomain;
export const KLINIK_SILOAH_LISTING_URL = parser.LISTING_URL;
