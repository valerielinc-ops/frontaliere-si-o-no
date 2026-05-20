#!/usr/bin/env node
/**
 * Privatklinik Villa im Park (Rothrist, AG) — SMN clinic PKV.
 *
 * Acute private hospital of Swiss Medical Network, located on the
 * Rothrist hill (AG). Listing endpoint:
 *
 *   https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKV
 *
 * Jobs route through SmartRecruiters (SwissMedicalNetwork1 tenant).
 * Confirmed clinic code via the dropdown on the SMN careers page.
 */
import { createSmnClinicParser } from './smn-clinic-job-parser.mjs';

export const SMN_PKV_KEY = 'smn-pkv';
export const SMN_PKV_COMPANY_NAME = 'Privatklinik Villa im Park';
export const SMN_PKV_COMPANY_DOMAIN = 'swissmedical.net';

const parser = createSmnClinicParser({
  companyKey: SMN_PKV_KEY,
  companyName: SMN_PKV_COMPANY_NAME,
  clinicCode: 'PKV',
  companyDomain: SMN_PKV_COMPANY_DOMAIN,
  defaultCanton: 'AG',
  defaultCity: 'Rothrist',
  defaultPostalCode: '4852',
  streetAddress: 'Bernstrasse 84, 4852 Rothrist',
  publicCareerUrl: 'https://www.swissmedical.net/de/karriere/stellenangebote?clinic=PKV',
  defaultSourceLang: 'de',
});

export const fetchAllSmnPkvJobs = parser.fetchAllJobs;
export const isSmnPkvJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
export const SMN_PKV_LISTING_URL = parser.LISTING_URL;
